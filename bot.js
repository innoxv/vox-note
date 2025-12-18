require('dotenv').config();
const { Telegraf } = require('telegraf');
const { pipeline } = require('@xenova/transformers');
const { createClient } = require('@supabase/supabase-js');
const gTTS = require('gtts');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const express = require('express');

// Production mode check
const isProduction = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || 3000;

// Initialize Express app for health checks
const app = express();
app.use(express.json());

// Initialize Supabase
let supabase = null;
let supabaseAvailable = false;

try {
  if (process.env.EXPO_PUBLIC_SUPABASE_URL && process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY) {
    supabase = createClient(
      process.env.EXPO_PUBLIC_SUPABASE_URL,
      process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY
    );
    supabaseAvailable = true;
    console.log('Supabase client initialized');
  } else {
    console.log('Supabase env vars not set - knowledge base disabled');
  }
} catch (e) {
  console.warn('Could not initialize Supabase client:', e?.message || e);
}

const bot = new Telegraf(process.env.BOT_TOKEN);
let transcriber = null;

// ==================== HEALTH CHECK ENDPOINT ====================

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'telegram-ai-support-bot',
    timestamp: new Date().toISOString(),
    supabase: supabaseAvailable ? 'connected' : 'disconnected',
    whisper: transcriber ? 'loaded' : 'loading'
  });
});

// ==================== ENHANCED MATCHING FUNCTIONS ====================

const SYNONYM_MAP = {
  'hello': ['hi', 'hey', 'hi there', 'hello there'],
  'how are you': ['how do you do', 'hows it going', 'whats up'],
  'what are you': ['who are you', 'what is this'],
  'help': ['support', 'assist', 'aid'],
  'thank you': ['thanks', 'thx', 'appreciate it'],
  'bye': ['goodbye', 'see you', 'farewell'],
  'voice': ['speak', 'talk', 'microphone'],
  'account': ['login', 'sign in', 'profile'],
  'password': ['reset password', 'forgot password'],
};

const QUESTION_PATTERNS = [
  { regex: /^(what|who|where|when|why|how|can|is|are|do|does|will|would|should|could)\b/i, type: 'question' },
  { regex: /\?$/, type: 'question' },
];

const calculateWordOverlap = (str1, str2) => {
  const words1 = str1.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const words2 = str2.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  
  if (words1.length === 0 || words2.length === 0) return 0;
  
  const commonWords = words1.filter(word => 
    words2.some(w2 => w2.includes(word) || word.includes(w2))
  );
  
  return commonWords.length / Math.max(words1.length, words2.length);
};

const findInSupabase = async (query) => {
  if (!supabaseAvailable) return null;
  
  try {
    const q = query.trim().toLowerCase();
    
    // Exact match
    let { data, error } = await supabase
      .from('knowledge_base')
      .select('question, answer, content')
      .ilike('question', q)
      .limit(1);
    
    if (error) throw error;
    if (data && data.length > 0) {
      return data[0].answer || data[0].content;
    }
    
    // Synonym match
    for (const [mainQuestion, synonyms] of Object.entries(SYNONYM_MAP)) {
      if (synonyms.includes(q) || q.includes(mainQuestion)) {
        const { data: synData } = await supabase
          .from('knowledge_base')
          .select('question, answer')
          .ilike('question', `%${mainQuestion}%`)
          .limit(1);
        
        if (synData && synData.length > 0) {
          return synData[0].answer;
        }
      }
    }
    
    // Search in content
    const { data: contentMatches } = await supabase
      .from('knowledge_base')
      .select('answer, content')
      .or(`answer.ilike.%${q}%,content.ilike.%${q}%`)
      .limit(1);
    
    if (contentMatches && contentMatches.length > 0) {
      return contentMatches[0].answer || contentMatches[0].content;
    }
    
    return null;
  } catch (err) {
    console.error('Supabase lookup error:', err.message || err);
    return null;
  }
};

const getDefaultResponse = (query) => {
  const q = query.toLowerCase().trim();
  
  let queryType = 'general';
  for (const pattern of QUESTION_PATTERNS) {
    if (pattern.regex.test(q)) {
      queryType = pattern.type;
      break;
    }
  }
  
  if (['hello', 'hi', 'hey'].some(g => q.includes(g))) {
    queryType = 'greeting';
  }
  
  const responses = {
    greeting: `Hello! I don't have specific info about "${query}" yet, but I'd love to learn!`,
    question: `That's a great question about "${query}"! I need to learn more about this topic.`,
    general: `I'm still learning about "${query}". Would you like to teach me?`
  };
  
  const baseResponse = responses[queryType] || responses.general;
  
  return `${baseResponse}\n\nTeach me:\n/add "${query}" || [your answer here]`;
};

const addKnowledge = async (input) => {
  if (!supabaseAvailable) throw new Error('Supabase not available');
  
  let question, answer;
  
  if (input.includes('||')) {
    const parts = input.split('||').map(part => part.trim());
    if (parts.length >= 2) {
      question = parts[0];
      answer = parts.slice(1).join('||').trim();
    } else {
      throw new Error('Invalid format. Use: question || answer');
    }
  } else {
    answer = input.trim();
    question = answer.split(/[.!?]/)[0].substring(0, 50).trim() || 'General information';
  }
  
  if (!question || question.length < 2) {
    throw new Error('Question is too short or invalid');
  }
  
  if (!answer || answer.length < 2) {
    throw new Error('Answer is too short or invalid');
  }
  
  const { data: existing } = await supabase
    .from('knowledge_base')
    .select('id, question')
    .ilike('question', question)
    .limit(1);
  
  let result;
  if (existing && existing.length > 0) {
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

// ==================== AUDIO PROCESSING ====================

(async () => {
  try {
    console.log('Loading Whisper model...');
    transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en');
    console.log('Whisper model ready!');
  } catch (err) {
    console.error('Failed to load model:', err);
  }
})();

const decodeAudioToFloat32 = async (url, samplingRate = 16000) => {
  const response = await fetch(url);
  const arrayBuffer = await response.arrayBuffer();
  
  const ffmpeg = spawn('ffmpeg', [
    '-i', 'pipe:0',
    '-f', 'f32le',
    '-ar', String(samplingRate),
    '-ac', '1',
    '-hide_banner',
    '-loglevel', 'error',
    'pipe:1'
  ]);
  
  ffmpeg.stdin.end(Buffer.from(arrayBuffer));
  
  const chunks = [];
  ffmpeg.stdout.on('data', chunk => chunks.push(chunk));
  
  await new Promise((resolve, reject) => {
    ffmpeg.on('close', resolve);
    ffmpeg.on('error', reject);
  });
  
  const audioData = new Float32Array(Buffer.concat(chunks).buffer);
  return audioData;
};

const textToVoice = async (text) => {
  return new Promise((resolve, reject) => {
    const tts = new gTTS(text, 'en');
    
    const tempDir = isProduction ? '/tmp' : path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    const tempFile = path.join(tempDir, `tts-${Date.now()}.mp3`);
    
    tts.save(tempFile, (err) => {
      if (err) return reject(err);
      
      fs.readFile(tempFile, (readErr, data) => {
        fs.unlink(tempFile, (unlinkErr) => {
          if (unlinkErr) console.error('Failed to delete temp file:', unlinkErr);
        });
        
        if (readErr) return reject(readErr);
        resolve(data);
      });
    });
  });
};

// ==================== BOT COMMANDS ====================

const getKnowledgeCount = async () => {
  if (!supabaseAvailable) return 0;
  try {
    const { data, error } = await supabase
      .from('knowledge_base')
      .select('id');
    
    if (error) {
      console.error('Error getting knowledge count:', error);
      return 0;
    }
    return data ? data.length : 0;
  } catch (err) {
    console.error('Error in getKnowledgeCount:', err);
    return 0;
  }
};

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

bot.command('add', async (ctx) => {
  if (!supabaseAvailable) {
    return ctx.reply('Knowledge base unavailable.');
  }
  
  const payload = ctx.message.text?.replace(/^\/add\s*/i, '').trim();
  if (!payload) {
    return ctx.reply('Usage: /add "question" || "answer"\nExample: /add "What is the return policy?" || "30-day returns"');
  }
  
  try {
    const { question, answer, result } = await addKnowledge(payload);
    const response = `${result}\n\nQ: ${question}\nA: ${answer.substring(0, 200)}${answer.length > 200 ? '...' : ''}`;
    ctx.reply(response);
  } catch (err) {
    console.error('Add error:', err);
    ctx.reply(`Error: ${err.message}`);
  }
});

bot.command('search', async (ctx) => {
  if (!supabaseAvailable) {
    return ctx.reply('Knowledge base unavailable.');
  }
  
  const query = ctx.message.text?.replace(/^\/search\s*/i, '').trim();
  if (!query) {
    return ctx.reply('Usage: /search [query]\nExample: /search password reset');
  }
  
  try {
    const result = await findInSupabase(query);
    if (result) {
      await ctx.reply(`Found:\n\n${result}`);
    } else {
      await ctx.reply(`No match found for "${query}"`);
    }
  } catch (err) {
    console.error('Search error:', err);
    await ctx.reply('Error searching knowledge base.');
  }
});

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
      .limit(10);
    
    if (data && data.length > 0) {
      let response = 'Frequently Asked Questions\n\n';
      data.forEach((item, index) => {
        response += `${index + 1}. ${item.question}\n`;
      });
      
      response += `\nTotal: ${data.length} questions\nUse /search [topic] to find answers`;
      await ctx.reply(response);
    } else {
      await ctx.reply('No FAQs yet. Add one with /add "question" || "answer"');
    }
  } catch (err) {
    console.error('FAQ error:', err);
    await ctx.reply('Error loading FAQs.');
  }
});

// ==================== MESSAGE HANDLERS ====================

bot.on('voice', async (ctx) => {
  await ctx.reply('Listening...');

  try {
    const file = await ctx.telegram.getFile(ctx.message.voice.file_id);
    const audioUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;

    const audioFloat32 = await decodeAudioToFloat32(audioUrl, 16000);

    if (!transcriber) {
      await ctx.reply('Model still loading... try again in a moment.');
      return;
    }

    const result = await transcriber(audioFloat32);
    const userText = result.text?.trim() || 'I heard nothing';
    
    await ctx.reply(`You said: ${userText}`);
    
    if (supabaseAvailable) {
      // Save transcript
      try {
        await supabase.from('messages').insert([{ 
          user_id: ctx.from?.id?.toString?.() || null, 
          text: userText, 
          source: 'voice' 
        }]);
      } catch (e) {
        console.error('Failed to save transcript:', e.message);
      }
    }

    let replyText;
    if (supabaseAvailable) {
      const kbAnswer = await findInSupabase(userText);
      if (kbAnswer) {
        replyText = kbAnswer;
      } else {
        replyText = getDefaultResponse(userText);
      }
    } else {
      replyText = getDefaultResponse(userText);
    }

    await ctx.reply(replyText);

    try {
      const voiceBuffer = await textToVoice(replyText);
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

bot.on('text', async (ctx) => {
  const userText = ctx.message.text.trim();
  if (userText.startsWith('/')) return;

  let replyText;
  if (supabaseAvailable) {
    const kbAnswer = await findInSupabase(userText);
    if (kbAnswer) {
      replyText = kbAnswer;
    } else {
      replyText = getDefaultResponse(userText);
    }
  } else {
    replyText = getDefaultResponse(userText);
  }

  await ctx.reply(replyText);

  try {
    const voiceBuffer = await textToVoice(replyText);
    await ctx.replyWithVoice({ source: voiceBuffer });
  } catch (err) {
    console.error('Voice synthesis failed:', err.message);
  }
});

// ==================== DEPLOYMENT MODE ====================

if (isProduction) {
  // Production mode with webhook (for Render)
  const RENDER_URL = process.env.RENDER_EXTERNAL_URL || `https://your-service-name.onrender.com`;
  
  // Set webhook
  bot.telegram.setWebhook(`${RENDER_URL}/bot${process.env.BOT_TOKEN}`);
  
  // Use webhook callback
  app.use(bot.webhookCallback(`/bot${process.env.BOT_TOKEN}`));
  
  app.listen(PORT, () => {
    console.log(`Bot running in production mode on port ${PORT}`);
    console.log(`Webhook URL: ${RENDER_URL}/bot${process.env.BOT_TOKEN}`);
    console.log(`Health check: ${RENDER_URL}/health`);
  });
} else {
  // Development mode with polling
  bot.launch().then(() => {
    console.log('Bot running in development mode');
  });
}

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));