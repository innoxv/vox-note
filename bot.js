require('dotenv').config();
const { Telegraf } = require('telegraf');
const { pipeline } = require('@xenova/transformers');

// Supabase client setup
let supabase = null;
try {
  const { createClient } = require('@supabase/supabase-js');
  if (process.env.EXPO_PUBLIC_SUPABASE_URL && process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY) {
    supabase = createClient(process.env.EXPO_PUBLIC_SUPABASE_URL, process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY);
    console.log('Supabase client initialized');
  } else {
    console.log('Supabase env vars not set — knowledge base disabled');
  }
} catch (e) {
  console.warn('Could not initialize Supabase client:', e?.message || e);
}

let supabaseAvailable = !!supabase;

// ==================== ENHANCED MATCHING FUNCTIONS ====================

// Synonym and variation mapping for better matching
const SYNONYM_MAP = {
  // Greetings
  'hello': ['hi', 'hey', 'hi there', 'hello there', 'howdy', 'greetings', 'yo', 'sup'],
  'good morning': ['morning', 'top of the morning'],
  'good afternoon': ['afternoon'],
  'good evening': ['evening', 'night'],
  
  // Help/Support
  'help': ['support', 'assist', 'aid', 'guidance', 'trouble', 'problem', 'issue'],
  'support': ['customer service', 'help desk', 'assistance', 'tech support'],
  
  // Thanks
  'thank you': ['thanks', 'thx', 'thank you very much', 'appreciate it', 'cheers', 'grateful'],
  
  // Farewells
  'bye': ['goodbye', 'see you', 'farewell', 'later', 'take care', 'cya', 'adios'],
  
  // Questions
  'how are you': ['how do you do', 'hows it going', 'whats up', 'how are things', 'hows life'],
  'what are you': ['who are you', 'what is this', 'what is this bot'],
  'what can you do': ['capabilities', 'features', 'functions', 'abilities', 'what do you do'],
  
  // Voice/Technical
  'voice': ['speak', 'talk', 'microphone', 'audio', 'sound', 'voice message'],
  'how do i use': ['how to use', 'how does this work', 'instructions', 'tutorial'],
  
  // Account
  'account': ['login', 'sign in', 'profile', 'user', 'credentials'],
  'password': ['reset password', 'forgot password', 'change password', 'lost password'],
  
  // Pricing
  'price': ['cost', 'pricing', 'fee', 'charge', 'subscription', 'how much', 'costs'],
  'free': ['free trial', 'no cost', 'complimentary', 'gratis'],
  
  // Technical
  'error': ['problem', 'issue', 'bug', 'not working', 'broken', 'failed'],
  'not working': ['doesnt work', 'not functioning', 'broken', 'malfunctioning'],
};

// Common question patterns
const QUESTION_PATTERNS = [
  { regex: /^(what|who|where|when|why|how|can|is|are|do|does|will|would|should|could)\b/i, type: 'question' },
  { regex: /\?$/, type: 'question' },
  { regex: /^(tell me|explain|describe|show me|teach me)/i, type: 'explanation' },
  { regex: /^(how to|how do i|steps to|guide to)/i, type: 'howto' },
];

// Enhanced findInSupabase with multiple matching strategies
const findInSupabase = async (query) => {
  if (!supabaseAvailable) return null;
  
  try {
    const q = query.trim().toLowerCase();
    const originalQ = query.trim();
    
    console.log(`Searching for: "${q}"`);
    
    // STRATEGY 1: Exact match (case-insensitive)
    let { data, error } = await supabase
      .from('knowledge_base')
      .select('question, answer, content, created_at')
      .ilike('question', q)
      .limit(1);
    
    if (error) throw error;
    if (data && data.length > 0) {
      console.log(`Exact match found: "${data[0].question}"`);
      return data[0].answer || data[0].content;
    }
    
    // STRATEGY 2: Check synonyms and variations
    for (const [mainQuestion, synonyms] of Object.entries(SYNONYM_MAP)) {
      if (synonyms.includes(q) || q.includes(mainQuestion)) {
        const { data: synData } = await supabase
          .from('knowledge_base')
          .select('question, answer')
          .ilike('question', `%${mainQuestion}%`)
          .limit(1);
        
        if (synData && synData.length > 0) {
          console.log(`Synonym match: "${q}" → "${synData[0].question}"`);
          return synData[0].answer;
        }
      }
    }
    
    // STRATEGY 3: Get all questions for smart matching
    const { data: allQuestions } = await supabase
      .from('knowledge_base')
      .select('question, answer, content')
      .not('question', 'is', null)
      .limit(100); // Increased limit for better matching
    
    if (allQuestions && allQuestions.length > 0) {
      // Score each question based on multiple factors
      const scoredQuestions = allQuestions.map(item => {
        const question = item.question.toLowerCase();
        const answer = item.answer || item.content || '';
        
        // Calculate various similarity scores
        const scores = {
          exactContains: question.includes(q) || q.includes(question) ? 1 : 0,
          wordOverlap: calculateWordOverlap(q, question),
          startsWith: q.startsWith(question.split(' ')[0]) ? 0.8 : 0,
          endsWith: q.endsWith(question.split(' ').pop()) ? 0.6 : 0,
          lengthSimilarity: 1 - Math.abs(question.length - q.length) / Math.max(question.length, q.length),
          answerContains: answer.toLowerCase().includes(q) ? 0.5 : 0,
        };
        
        // Weighted total score
        const totalScore = 
          scores.exactContains * 3 +
          scores.wordOverlap * 2 +
          scores.startsWith * 1.5 +
          scores.endsWith * 1 +
          scores.lengthSimilarity * 0.5 +
          scores.answerContains * 0.3;
        
        return { ...item, score: totalScore };
      });
      
      // Filter and sort by score
      const sortedQuestions = scoredQuestions
        .filter(item => item.score > 0.3) // Threshold
        .sort((a, b) => b.score - a.score);
      
      if (sortedQuestions.length > 0) {
        console.log(`Best match: "${sortedQuestions[0].question}" (score: ${sortedQuestions[0].score.toFixed(2)})`);
        return sortedQuestions[0].answer || sortedQuestions[0].content;
      }
    }
    
    // STRATEGY 4: Search in answers/content as fallback
    const { data: contentMatches } = await supabase
      .from('knowledge_base')
      .select('answer, content')
      .or(`answer.ilike.%${q}%,content.ilike.%${q}%`)
      .order('created_at', { ascending: false })
      .limit(1);
    
    if (contentMatches && contentMatches.length > 0) {
      console.log(`Content match found`);
      return contentMatches[0].answer || contentMatches[0].content;
    }
    
    console.log(`No match found for: "${q}"`);
    return null;
  } catch (err) {
    console.error('Supabase lookup error:', err.message || err);
    return null;
  }
};

// Helper function to calculate word overlap
const calculateWordOverlap = (str1, str2) => {
  const words1 = str1.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const words2 = str2.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  
  if (words1.length === 0 || words2.length === 0) return 0;
  
  const commonWords = words1.filter(word => 
    words2.some(w2 => w2.includes(word) || word.includes(w2))
  );
  
  return commonWords.length / Math.max(words1.length, words2.length);
};

// Enhanced getDefaultResponse with context awareness
const getDefaultResponse = (query) => {
  const q = query.toLowerCase().trim();
  
  // Classify the query type
  let queryType = 'general';
  for (const pattern of QUESTION_PATTERNS) {
    if (pattern.regex.test(q)) {
      queryType = pattern.type;
      break;
    }
  }
  
  // Check if it's a greeting
  if (['hello', 'hi', 'hey', 'good morning', 'good afternoon', 'good evening'].some(g => q.includes(g))) {
    queryType = 'greeting';
  }
  
  // Context-aware responses
  const responses = {
    greeting: `Hello! I'm your AI assistant. I don't have specific info about "${query}" yet, but I'd love to learn!`,
    question: `That's a great question about "${query}"! I need to learn more about this topic.`,
    explanation: `I'd be happy to explain "${query}"! First, I need to learn about it.`,
    howto: `I can help you with "${query}"! Let me learn the steps first.`,
    general: `I'm still learning about "${query}". Would you like to teach me?`
  };
  
  const baseResponse = responses[queryType] || responses.general;
  
  // Suggest related topics if available
  const suggestions = getRelatedSuggestions(q);
  const suggestionText = suggestions ? `\n\n **Related topics:** ${suggestions}` : '';
  
  return `${baseResponse}\n\n **Teach me:**\n\`/add "${query}" || [your answer here]\`` + suggestionText;
};

// Get related suggestions from knowledge base
const getRelatedSuggestions = async (query) => {
  if (!supabaseAvailable) return null;
  
  try {
    const words = query.split(/\s+/).filter(w => w.length > 3);
    if (words.length === 0) return null;
    
    const { data } = await supabase
      .from('knowledge_base')
      .select('question')
      .or(words.map(w => `question.ilike.%${w}%`).join(','))
      .limit(3);
    
    if (data && data.length > 0) {
      return data.map(item => `"${item.question}"`).join(', ');
    }
  } catch (err) {
    console.error('Error getting suggestions:', err.message);
  }
  return null;
};

// ==================== ENHANCED KNOWLEDGE MANAGEMENT ====================

const saveTranscript = async (userId, text, source = 'voice') => {
  if (!supabaseAvailable) return;
  try {
    await supabase.from('messages').insert([{ 
      user_id: userId?.toString?.() || null, 
      text, 
      source 
    }]);
  } catch (err) {
    console.error('Failed to save transcript:', err.message || err);
  }
};

// Enhanced addKnowledge with better parsing and validation
const addKnowledge = async (input) => {
  if (!supabaseAvailable) throw new Error('Supabase not available');
  
  let question, answer;
  
  // Parse input
  if (input.includes('||')) {
    const parts = input.split('||').map(part => part.trim());
    if (parts.length >= 2) {
      question = parts[0];
      answer = parts.slice(1).join('||').trim();
    } else {
      throw new Error('Invalid format. Use: question || answer');
    }
  } else {
    // Auto-generate question from answer
    answer = input.trim();
    question = generateQuestionFromAnswer(answer);
  }
  
  // Validate
  if (!question || question.length < 2) {
    throw new Error('Question is too short or invalid');
  }
  
  if (!answer || answer.length < 2) {
    throw new Error('Answer is too short or invalid');
  }
  
  // Check for existing question (case-insensitive)
  const { data: existing } = await supabase
    .from('knowledge_base')
    .select('id, question')
    .ilike('question', question)
    .limit(1);
  
  let result;
  if (existing && existing.length > 0) {
    // Update existing
    const { error } = await supabase
      .from('knowledge_base')
      .update({ 
        answer,
        content: answer,
        updated_at: new Date().toISOString()
      })
      .eq('id', existing[0].id);
    
    if (error) throw error;
    result = `Updated: "${existing[0].question}"`;
  } else {
    // Insert new
    const { error } = await supabase
      .from('knowledge_base')
      .insert([{ 
        question,
        answer,
        content: answer,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }]);
    
    if (error) throw error;
    result = `Added: "${question}"`;
  }
  
  return { question, answer, result };
};

// Helper to generate question from answer
const generateQuestionFromAnswer = (answer) => {
  // Extract key words or create a question
  const words = answer.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  if (words.length > 0) {
    // Use first significant word
    const firstWord = words[0];
    return `What is ${firstWord}?`;
  }
  
  // Fallback: first sentence or 50 chars
  return answer.split(/[.!?]/)[0].substring(0, 50).trim() || 'General information';
};

// ==================== 

let fetch = global.fetch;
if (!fetch) {
  try { fetch = require('undici').fetch; }
  catch (e1) {
    try { 
      const nf = require('node-fetch');
      fetch = nf.default || nf;
    } catch (e2) {
      console.error('No fetch implementation found.');
      throw e2;
    }
  }
}

const fetchWithRetry = async (url, options = {}, attempts = 3, timeoutMs = 10000) => {
  for (let i = 1; i <= attempts; i++) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal, ...options });
      clearTimeout(id);
      if (!res.ok) {
        let txt = '';
        try { txt = await res.text(); } catch (e) { /* ignore */ }
        throw new Error(`Fetch failed: ${res.status} ${res.statusText} - ${txt}`);
      }
      return res;
    } catch (err) {
      clearTimeout(id);
      const isLast = i === attempts;
      if (isLast) throw err;
      await new Promise((r) => setTimeout(r, 1000 * i));
    }
  }
};

const gTTS = require('gtts');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const bot = new Telegraf(process.env.BOT_TOKEN);

let transcriber = null;

// Load Whisper Tiny on startup
(async () => {
  try {
    console.log('Loading Whisper model... (first time ~80MB)');
    transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en');
    console.log('Whisper model ready!');
  } catch (err) {
    console.error('Failed to load model:', err);
  }
})();

const textToVoice = async (text) => {
  const tts = new gTTS(text, 'en');
  const tmpFile = path.join(os.tmpdir(), `tts-${Date.now()}.mp3`);
  
  return new Promise((resolve, reject) => {
    tts.save(tmpFile, (err) => {
      if (err) return reject(err);
      
      fs.readFile(tmpFile, (readErr, data) => {
        fs.unlink(tmpFile, () => {});
        if (readErr) return reject(readErr);
        resolve(data);
      });
    });
  });
};

// ==================== ENHANCED BOT COMMANDS ====================

// Get knowledge count
const getKnowledgeCount = async () => {
  if (!supabaseAvailable) return 0;
  try {
    const { count, error } = await supabase
      .from('knowledge_base')
      .select('*', { count: 'exact', head: true });
    
    if (error) {
      console.error('Error getting knowledge count:', error);
      return 0;
    }
    return count || 0;
  } catch (err) {
    console.error('Error in getKnowledgeCount:', err);
    return 0;
  }
};

// Start command
bot.start(async (ctx) => {
  let welcomeMsg;
  
  if (supabaseAvailable) {
    const knowledgeCount = await getKnowledgeCount();
    welcomeMsg = `Welcome! I'm your AI voice assistant with ${knowledgeCount} pieces of knowledge.\n\n` +
                `Send voice or text, and I'll reply from my knowledge base!\n` +
                `Try: /faq - See common questions\n` +
                `Try: /search [topic] - Search knowledge\n` +
                `Try: /add "question" || "answer" - Add new knowledge`;
  } else {
    welcomeMsg = 'Welcome! Send voice or text. (Knowledge base not available)';
  }
  
  ctx.reply(welcomeMsg);
});

// Enhanced /add command
bot.command('add', async (ctx) => {
  if (!supabaseAvailable) {
    return ctx.reply('Knowledge base unavailable.');
  }
  
  const payload = ctx.message.text?.replace(/^\/add\s*/i, '').trim();
  if (!payload) {
    return ctx.reply(`**Usage:**\n\`/add "question" || "answer"\`\n\n**Examples:**\n• \`/add What is the return policy? || 30-day returns\`\n• \`/add How to reset password? || Click "Forgot Password" on login page\``, { parse_mode: 'Markdown' });
  }
  
  try {
    const { question, answer, result } = await addKnowledge(payload);
    const response = `${result}\n\n**Q:** ${question}\n**A:** ${answer.substring(0, 200)}${answer.length > 200 ? '...' : ''}`;
    ctx.reply(response, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Add error:', err);
    ctx.reply(`Error: ${err.message}\n\nFormat: \`/add "question" || "answer"\``, { parse_mode: 'Markdown' });
  }
});

// Enhanced /search command
bot.command('search', async (ctx) => {
  if (!supabaseAvailable) {
    return ctx.reply('Knowledge base unavailable.');
  }
  
  const query = ctx.message.text?.replace(/^\/search\s*/i, '').trim();
  if (!query) {
    return ctx.reply('**Usage:** `/search [query]`\nExample: `/search password reset`', { parse_mode: 'Markdown' });
  }
  
  try {
    const result = await findInSupabase(query);
    if (result) {
      await ctx.reply(`**Found:**\n\n${result}`, { parse_mode: 'Markdown' });
    } else {
      const suggestions = await getRelatedSuggestions(query);
      let reply = `No exact match for "${query}"`;
      if (suggestions) {
        reply += `\n\n **Related topics:** ${suggestions}\n Try asking about one of these!`;
      }
      await ctx.reply(reply);
    }
  } catch (err) {
    console.error('Search error:', err);
    await ctx.reply('Error searching knowledge base.');
  }
});

// New: /faq command
bot.command('faq', async (ctx) => {
  if (!supabaseAvailable) {
    return ctx.reply('Knowledge base unavailable.');
  }
  
  try {
    const { data } = await supabase
      .from('knowledge_base')
      .select('question')
      .not('question', 'is', null)
      .order('question')
      .limit(15);
    
    if (data && data.length > 0) {
      let response = '**Frequently Asked Questions**\n\n';
      const categories = {};
      
      // Categorize questions
      data.forEach(item => {
        const question = item.question.toLowerCase();
        let category = 'General';
        
        if (question.includes('hello') || question.includes('hi') || question.includes('hey')) category = 'Greetings';
        else if (question.includes('how') && question.includes('use')) category = 'Usage';
        else if (question.includes('what') && question.includes('you')) category = 'About';
        else if (question.includes('account') || question.includes('login') || question.includes('password')) category = 'Account';
        else if (question.includes('price') || question.includes('cost') || question.includes('free')) category = 'Pricing';
        else if (question.includes('help') || question.includes('support')) category = 'Support';
        
        if (!categories[category]) categories[category] = [];
        categories[category].push(item.question);
      });
      
      // Build response
      for (const [category, questions] of Object.entries(categories)) {
        response += `**${category}:**\n`;
        questions.slice(0, 5).forEach(q => {
          response += `• ${q}\n`;
        });
        response += '\n';
      }
      
      response += `**Total knowledge:** ${await getKnowledgeCount()} items\n`;
      response += '**Search:** `/search [topic]`\n';
      response += '**Add:** `/add "question" || "answer"`';
      
      await ctx.reply(response, { parse_mode: 'Markdown' });
    } else {
      await ctx.reply('No FAQs yet. Be the first to add one!\n\n`/add "question" || "answer"`', { parse_mode: 'Markdown' });
    }
  } catch (err) {
    console.error('FAQ error:', err);
    await ctx.reply('Error loading FAQs.');
  }
});

// New: /stats command
bot.command('stats', async (ctx) => {
  if (!supabaseAvailable) {
    return ctx.reply('Knowledge base unavailable.');
  }
  
  try {
    const count = await getKnowledgeCount();
    const response = `**Knowledge Base Stats**\n\n` +
                     `• Total entries: ${count}\n` +
                     `• Voice model: ${transcriber ? 'Ready' : 'Loading'}\n` +
                     `• Supabase: Connected\n` +
                     `• Last check: ${new Date().toLocaleTimeString()}\n\n` +
                     `Use /faq to see available questions`;
    
    await ctx.reply(response, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Stats error:', err);
    await ctx.reply('Error getting stats.');
  }
});

// ==================== MESSAGE HANDLERS (Optimized) ====================

// Handle voice messages
bot.on('voice', async (ctx) => {
  await ctx.reply('Listening...');

  try {
    const file = await ctx.telegram.getFile(ctx.message.voice.file_id);
    const audioUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;

    const decodeAudioToFloat32 = async (url, samplingRate = 16000) => {
      const res = await fetchWithRetry(url, {}, 3, 15000);

      const ff = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-i', 'pipe:0',
        '-f', 'f32le',
        '-ar', String(samplingRate),
        '-ac', '1',
        'pipe:1',
      ]);

      const fetchedArrayBuffer = await res.arrayBuffer();
      ff.stdin.end(Buffer.from(fetchedArrayBuffer));

      const chunks = [];
      ff.stdout.on('data', (c) => chunks.push(c));
      
      await new Promise((resolve, reject) => {
        ff.on('error', reject);
        ff.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg code: ${code}`)));
      });

      const pcmBuf = Buffer.concat(chunks);
      return new Float32Array(pcmBuf.buffer, pcmBuf.byteOffset, pcmBuf.byteLength / 4);
    };

    const audioFloat32 = await decodeAudioToFloat32(audioUrl, 16000);

    if (!transcriber) {
      await ctx.reply('Model still loading... try again in a moment.');
      return;
    }

    const result = await transcriber(audioFloat32);
    const userText = result.text?.trim() || 'I heard nothing';
    
    await ctx.reply(`**You said:** ${userText}`, { parse_mode: 'Markdown' });
    
    if (supabaseAvailable) {
      await saveTranscript(ctx.from?.id, userText, 'voice');
    }

    let replyText;
    if (supabaseAvailable) {
      const kbAnswer = await findInSupabase(userText);
      if (kbAnswer) {
        replyText = `${kbAnswer}`;
      } else {
        replyText = getDefaultResponse(userText);
      }
    } else {
      replyText = getDefaultResponse(userText);
    }

    await ctx.reply(replyText, { parse_mode: 'Markdown' });

    try {
      const voiceBuffer = await textToVoice(replyText.replace(/\*\*/g, '').replace(/`/g, ''));
      await ctx.replyWithVoice({ source: voiceBuffer });
    } catch (err) {
      console.error('Voice generation failed:', err.message);
      await ctx.reply('(Voice reply failed)');
    }
  } catch (err) {
    console.error('Voice error:', err);
    await ctx.reply('Sorry, error processing voice. Try typing instead.');
  }
});

// Handle text messages
bot.on('text', async (ctx) => {
  const userText = ctx.message.text.trim();
  if (userText.startsWith('/')) return;

  if (supabaseAvailable) {
    await saveTranscript(ctx.from?.id, userText, 'text');
  }

  let replyText;
  if (supabaseAvailable) {
    const kbAnswer = await findInSupabase(userText);
    if (kbAnswer) {
      replyText = `${kbAnswer}`;
    } else {
      replyText = getDefaultResponse(userText);
    }
  } else {
    replyText = getDefaultResponse(userText);
  }

  await ctx.reply(replyText, { parse_mode: 'Markdown' });

  try {
    const voiceBuffer = await textToVoice(replyText.replace(/\*\*/g, '').replace(/`/g, ''));
    await ctx.replyWithVoice({ source: voiceBuffer });
  } catch (err) {
    console.error('Voice generation failed:', err.message);
    await ctx.reply('(Voice reply failed)');
  }
});

// ==================== BOT STARTUP ====================

const startBot = async (maxAttempts = 5) => {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await bot.launch();
      console.log('🤖 Bot running!');
      console.log(supabaseAvailable ? 'Knowledge base: Active' : 'Knowledge base: Disabled');
      console.log('Voice transcription: ' + (transcriber ? 'Ready' : 'Loading'));
      
      if (supabaseAvailable) {
        const count = await getKnowledgeCount();
        console.log(`Knowledge items: ${count}`);
      }
      
      process.once('SIGINT', () => bot.stop('SIGINT'));
      process.once('SIGTERM', () => bot.stop('SIGTERM'));
      return;
    } catch (err) {
      console.error(`Launch attempt ${attempt} failed:`, err.message);
      if (attempt === maxAttempts) {
        console.error('Max restart attempts reached — exiting.');
        process.exit(1);
      }
      await new Promise(res => setTimeout(res, 2000 * attempt));
    }
  }
};

startBot();