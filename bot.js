require('dotenv').config();
const { Telegraf, session, MemorySessionStore } = require('telegraf');
const { pipeline } = require('@xenova/transformers');
const axios = require('axios');
const { PdfReader } = require("pdfreader");

// ==================== CRASH PREVENTION SETTINGS ====================
const SAFETY_CONFIG = {
  MAX_REQUEST_TIME: 25000,
  MAX_MEMORY_MB: 400,
  REQUEST_QUEUE_SIZE: 5,
  MAX_FILE_SIZE_MB: 10,
  HEALTH_CHECK_INTERVAL: 30000,
};

let activeRequests = 0;
let isShuttingDown = false;
const requestQueue = [];

// ==================== SUPABASE SETUP ====================
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

const SYNONYM_MAP = {
  'hello': ['hi', 'hey', 'hi there', 'hello there', 'howdy', 'greetings', 'yo', 'sup'],
  'good morning': ['morning', 'top of the morning'],
  'good afternoon': ['afternoon'],
  'good evening': ['evening', 'night'],
  'help': ['support', 'assist', 'aid', 'guidance', 'trouble', 'problem', 'issue'],
  'support': ['customer service', 'help desk', 'assistance', 'tech support'],
  'thank you': ['thanks', 'thx', 'thank you very much', 'appreciate it', 'cheers', 'grateful'],
  'bye': ['goodbye', 'see you', 'farewell', 'later', 'take care', 'cya', 'adios'],
  'how are you': ['how do you do', 'hows it going', 'whats up', 'how are things', 'hows life'],
  'what are you': ['who are you', 'what is this', 'what is this bot'],
  'what can you do': ['capabilities', 'features', 'functions', 'abilities', 'what do you do'],
  'voice': ['speak', 'talk', 'microphone', 'audio', 'sound', 'voice message'],
  'how do i use': ['how to use', 'how does this work', 'instructions', 'tutorial'],
  'account': ['login', 'sign in', 'profile', 'user', 'credentials'],
  'password': ['reset password', 'forgot password', 'change password', 'lost password'],
  'price': ['cost', 'pricing', 'fee', 'charge', 'subscription', 'how much', 'costs'],
  'free': ['free trial', 'no cost', 'complimentary', 'gratis'],
  'error': ['problem', 'issue', 'bug', 'not working', 'broken', 'failed'],
  'not working': ['doesnt work', 'not functioning', 'broken', 'malfunctioning'],
};

const QUESTION_PATTERNS = [
  { regex: /^(what|who|where|when|why|how|can|is|are|do|does|will|would|should|could)\b/i, type: 'question' },
  { regex: /\?$/, type: 'question' },
  { regex: /^(tell me|explain|describe|show me|teach me)/i, type: 'explanation' },
  { regex: /^(how to|how do i|steps to|guide to)/i, type: 'howto' },
];

const findInSupabase = async (query) => {
  if (!supabaseAvailable) return null;
  
  try {
    const q = query.trim().toLowerCase();
    const originalQ = query.trim();
    
    console.log(`Searching for: "${q}"`);
    
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
    
    const { data: allQuestions } = await supabase
      .from('knowledge_base')
      .select('question, answer, content')
      .not('question', 'is', null)
      .limit(100);
    
    if (allQuestions && allQuestions.length > 0) {
      const scoredQuestions = allQuestions.map(item => {
        const question = item.question.toLowerCase();
        const answer = item.answer || item.content || '';
        
        const scores = {
          exactContains: question.includes(q) || q.includes(question) ? 1 : 0,
          wordOverlap: calculateWordOverlap(q, question),
          startsWith: q.startsWith(question.split(' ')[0]) ? 0.8 : 0,
          endsWith: q.endsWith(question.split(' ').pop()) ? 0.6 : 0,
          lengthSimilarity: 1 - Math.abs(question.length - q.length) / Math.max(question.length, q.length),
          answerContains: answer.toLowerCase().includes(q) ? 0.5 : 0,
        };
        
        const totalScore = 
          scores.exactContains * 3 +
          scores.wordOverlap * 2 +
          scores.startsWith * 1.5 +
          scores.endsWith * 1 +
          scores.lengthSimilarity * 0.5 +
          scores.answerContains * 0.3;
        
        return { ...item, score: totalScore };
      });
      
      const sortedQuestions = scoredQuestions
        .filter(item => item.score > 0.3)
        .sort((a, b) => b.score - a.score);
      
      if (sortedQuestions.length > 0) {
        console.log(`Best match: "${sortedQuestions[0].question}" (score: ${sortedQuestions[0].score.toFixed(2)})`);
        return sortedQuestions[0].answer || sortedQuestions[0].content;
      }
    }
    
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

const calculateWordOverlap = (str1, str2) => {
  const words1 = str1.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const words2 = str2.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  
  if (words1.length === 0 || words2.length === 0) return 0;
  
  const commonWords = words1.filter(word => 
    words2.some(w2 => w2.includes(word) || word.includes(w2))
  );
  
  return commonWords.length / Math.max(words1.length, words2.length);
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
  
  if (['hello', 'hi', 'hey', 'good morning', 'good afternoon', 'good evening'].some(g => q.includes(g))) {
    queryType = 'greeting';
  }
  
  const responses = {
    greeting: `Hello! I'm your AI assistant. I don't have specific info about "${query}" yet, but I'd love to learn!`,
    question: `That's a great question about "${query}"! I need to learn more about this topic.`,
    explanation: `I'd be happy to explain "${query}"! First, I need to learn about it.`,
    howto: `I can help you with "${query}"! Let me learn the steps first.`,
    general: `I'm still learning about "${query}". Would you like to teach me?`
  };
  
  const baseResponse = responses[queryType] || responses.general;
  
  const suggestions = getRelatedSuggestions(q);
  const suggestionText = suggestions ? `\n\n **Related topics:** ${suggestions}` : '';
  
  return `${baseResponse}\n\n **Teach me:**\n\`/add "${query}" || [your answer here]\`` + suggestionText;
};

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
    question = generateQuestionFromAnswer(answer);
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

const generateQuestionFromAnswer = (answer) => {
  const words = answer.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  if (words.length > 0) {
    const firstWord = words[0];
    return `What is ${firstWord}?`;
  }
  
  return answer.split(/[.!?]/)[0].substring(0, 50).trim() || 'General information';
};

// ==================== GROQ CONFIGURATION ====================
const GROQ_CONFIG = {
  enabled: !!process.env.GROQ_API_KEY,
  apiKey: process.env.GROQ_API_KEY,
  endpoint: 'https://api.groq.com/openai/v1/chat/completions',
  timeout: 15000,
  
  availableModels: [
    'llama-3.1-8b-instant',
    'llama-3.2-3b-preview',
    'llama-3.2-1b-preview',
    'gemma2-9b-it'
  ],
  
  defaultModel: 'llama-3.1-8b-instant'
};

// ==================== PDF PROCESSING ====================
const extractTextFromPDF = async (buffer) => {
  return new Promise((resolve, reject) => {
    const textByPage = {};
    let pageCount = 0;
    let fullText = '';
    
    const reader = new PdfReader();
    
    reader.parseBuffer(buffer, (err, item) => {
      if (err) {
        reject(new Error(`PDF parsing error: ${err.message}`));
      } else if (!item) {
        const pages = Object.keys(textByPage).sort((a, b) => parseInt(a) - parseInt(b));
        pages.forEach(pageNum => {
          fullText += `Page ${pageNum}:\n${textByPage[pageNum]}\n\n`;
        });
        
        resolve({
          text: fullText.trim(),
          numPages: pageCount,
          info: {}
        });
      } else if (item.page) {
        pageCount = Math.max(pageCount, item.page);
        
        if (!textByPage[item.page]) {
          textByPage[item.page] = '';
        }
        
        if (item.text) {
          textByPage[item.page] += item.text + ' ';
        }
      }
    });
  });
};

const processDocument = async (fileBuffer, fileType, fileName = 'document') => {
  let extractedText = '';
  let documentInfo = {};
  
  if (fileType === 'pdf') {
    try {
      console.log(`Processing PDF: ${fileName}, Size: ${fileBuffer.length} bytes`);
      
      if (fileBuffer.length >= 5) {
        const header = fileBuffer.slice(0, 5).toString('ascii');
        if (header !== '%PDF-') {
          throw new Error('Invalid PDF file: Missing PDF header');
        }
      }
      
      const pdfData = await extractTextFromPDF(fileBuffer);
      extractedText = pdfData.text;
      documentInfo = {
        numPages: pdfData.numPages,
        info: pdfData.info
      };
      
      console.log(`PDF processed successfully: ${fileName}, Pages: ${pdfData.numPages}, Text length: ${extractedText.length}`);
      
      if (!extractedText || extractedText.trim().length === 0) {
        throw new Error('PDF appears to be scanned or image-based (no extractable text)');
      }
      
    } catch (error) {
      console.error(`PDF processing error for ${fileName}:`, error.message);
      
      if (error.message.includes('scanned') || error.message.includes('image-based')) {
        throw new Error('This PDF appears to be scanned (image-based). I can only extract text from searchable PDFs.');
      } else if (error.message.includes('Invalid PDF')) {
        throw new Error('Invalid PDF file. The file may be corrupted or not a valid PDF.');
      } else {
        throw new Error(`Failed to extract text from PDF: ${error.message}`);
      }
    }
  } else if (fileType === 'txt') {
    extractedText = fileBuffer.toString('utf-8');
    console.log(`TXT processed: ${fileName}, Text length: ${extractedText.length}`);
  } else {
    throw new Error(`Unsupported file type: ${fileType}. I support PDF and TXT files.`);
  }
  
  const cleanedText = extractedText
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 10000);
  
  return {
    text: cleanedText,
    originalLength: extractedText.length,
    info: documentInfo,
    wasTruncated: cleanedText.length < extractedText.length
  };
};

// ==================== CRASH PREVENTION HELPERS ====================
const processWithTimeout = async (operation, operationName, timeoutMs = SAFETY_CONFIG.MAX_REQUEST_TIME) => {
  if (isShuttingDown) {
    throw new Error('Bot is shutting down');
  }
  
  if (activeRequests >= SAFETY_CONFIG.REQUEST_QUEUE_SIZE) {
    return new Promise((resolve, reject) => {
      requestQueue.push({ resolve, reject });
    }).then(() => processWithTimeout(operation, operationName, timeoutMs));
  }
  
  activeRequests++;
  
  return new Promise(async (resolve, reject) => {
    const timeoutId = setTimeout(() => {
      console.error(`TIMEOUT: ${operationName} exceeded ${timeoutMs}ms`);
      reject(new Error(`Operation timed out after ${timeoutMs}ms`));
      activeRequests--;
      
      const index = requestQueue.findIndex(req => req.resolve === resolve);
      if (index > -1) {
        requestQueue.splice(index, 1);
      }
    }, timeoutMs);
    
    try {
      const result = await operation();
      clearTimeout(timeoutId);
      resolve(result);
    } catch (error) {
      clearTimeout(timeoutId);
      reject(error);
    } finally {
      activeRequests--;
      
      if (requestQueue.length > 0) {
        const nextRequest = requestQueue.shift();
        nextRequest.resolve();
      }
    }
  });
};

const queryGroqAI = async (question, context = null) => {
  if (!GROQ_CONFIG.enabled) return null;
  
  return processWithTimeout(async () => {
    let systemPrompt = `You are a helpful AI assistant. Provide accurate and concise answers.`;
    
    if (context) {
      systemPrompt += `\n\nRelevant context:\n${context.substring(0, 1500)}\n\n`;
    }
    
    const userPrompt = `Question: ${question}\n\nAnswer:`;
    
    try {
      const response = await axios.post(
        GROQ_CONFIG.endpoint,
        {
          model: GROQ_CONFIG.defaultModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.7,
          max_tokens: 800
        },
        {
          headers: {
            'Authorization': `Bearer ${GROQ_CONFIG.apiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: GROQ_CONFIG.timeout
        }
      );
      
      if (response.data?.choices?.[0]?.message?.content) {
        return response.data.choices[0].message.content.trim();
      }
      return null;
    } catch (error) {
      console.error('Groq request failed:', error.message);
      throw error;
    }
  }, 'Groq AI Query', GROQ_CONFIG.timeout + 5000);
};

// ==================== BOT INITIALIZATION ====================
const gTTS = require('gtts');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const bot = new Telegraf(process.env.BOT_TOKEN, {
  telegram: {
    apiRoot: 'https://api.telegram.org',
    agent: null,
    timeout: 10000,
    webhookReply: false
  },
  handlerTimeout: 29000
});

bot.use(session({
  store: new MemorySessionStore(),
  defaultSession: () => ({})
}));

// ==================== WHISPER MODEL ====================
let transcriber = null;
let isModelLoading = false;
const modelLoadQueue = [];

const loadTranscriber = async () => {
  return processWithTimeout(async () => {
    if (transcriber) return transcriber;
    
    if (isModelLoading) {
      return new Promise(resolve => {
        modelLoadQueue.push(resolve);
      });
    }
    
    isModelLoading = true;
    console.log('Loading Whisper model...');
    
    try {
      transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', {
        device: 'cpu',
        quantized: true
      });
      
      console.log('Whisper model ready');
      
      while (modelLoadQueue.length > 0) {
        const resolve = modelLoadQueue.shift();
        resolve(transcriber);
      }
      
      return transcriber;
    } catch (err) {
      console.error('Failed to load Whisper model:', err);
      throw err;
    } finally {
      isModelLoading = false;
    }
  }, 'Load Whisper Model', 60000);
};

// ==================== AUDIO PROCESSING ====================
const decodeAudioToFloat32 = async (url) => {
  return processWithTimeout(async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    
    try {
      const response = await fetch(url, { 
        signal: controller.signal,
        timeout: 15000
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const arrayBuffer = await response.arrayBuffer();
      clearTimeout(timeoutId);
      
      return new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', [
          '-i', 'pipe:0',
          '-f', 'f32le',
          '-ar', '16000',
          '-ac', '1',
          '-hide_banner',
          '-loglevel', 'error',
          '-t', '60',
          'pipe:1'
        ], {
          stdio: ['pipe', 'pipe', 'pipe']
        });
        
        ffmpeg.stdin.end(Buffer.from(arrayBuffer));
        
        const chunks = [];
        let stderr = '';
        
        ffmpeg.stdout.on('data', chunk => chunks.push(chunk));
        ffmpeg.stderr.on('data', data => stderr += data.toString());
        
        ffmpeg.on('close', (code) => {
          if (code !== 0) {
            reject(new Error(`FFmpeg error: ${stderr}`));
            return;
          }
          const buffer = Buffer.concat(chunks);
          resolve(new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4));
        });
        
        ffmpeg.on('error', reject);
      });
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }, 'Audio Decoding', 30000);
};

const textToVoice = async (text) => {
  return processWithTimeout(() => {
    return new Promise((resolve, reject) => {
      const tts = new gTTS(text.substring(0, 500), 'en');
      const tmpFile = path.join(os.tmpdir(), `tts-${Date.now()}.mp3`);
      
      tts.save(tmpFile, (err) => {
        if (err) return reject(err);
        
        fs.readFile(tmpFile, (readErr, data) => {
          fs.unlink(tmpFile, () => {});
          if (readErr) return reject(readErr);
          resolve(data);
        });
      });
    });
  }, 'Text to Speech', 15000);
};

// ==================== ENHANCED ANSWER FINDING ====================
const enhancedFindAnswer = async (query, useAI = false) => {
  if (useAI) {
    if (GROQ_CONFIG.enabled) {
      try {
        let context = null;
        if (supabaseAvailable) {
          try {
            const { data } = await supabase
              .from('knowledge_base')
              .select('answer')
              .or(`answer.ilike.%${query.substring(0, 20)}%,question.ilike.%${query.substring(0, 20)}%`)
              .limit(2);
            
            if (data && data.length > 0) {
              context = data.map(item => item.answer).join('\n');
            }
          } catch (contextErr) {
            console.log('Context fetch error:', contextErr.message);
          }
        }
        
        const aiAnswer = await queryGroqAI(query, context);
        
        if (aiAnswer) {
          return {
            source: 'groq_ai',
            answer: aiAnswer
          };
        }
      } catch (error) {
        console.error('Groq AI error:', error.message);
      }
    }
    
    return {
      source: 'default',
      answer: getDefaultResponse(query)
    };
  }
  
  if (supabaseAvailable) {
    try {
      const kbAnswer = await processWithTimeout(
        () => findInSupabase(query),
        'Knowledge Base Search',
        10000
      );
      
      if (kbAnswer) {
        return {
          source: 'knowledge_base',
          answer: kbAnswer
        };
      }
    } catch (error) {
      console.error('Knowledge base search error:', error.message);
    }
  }
  
  if (GROQ_CONFIG.enabled) {
    try {
      let context = null;
      if (supabaseAvailable) {
        try {
          const { data } = await supabase
            .from('knowledge_base')
            .select('answer')
            .or(`answer.ilike.%${query.substring(0, 20)}%,question.ilike.%${query.substring(0, 20)}%`)
            .limit(2);
          
          if (data && data.length > 0) {
            context = data.map(item => item.answer).join('\n');
          }
        } catch (contextErr) {
          console.log('Context fetch error:', contextErr.message);
        }
      }
      
      const aiAnswer = await queryGroqAI(query, context);
      
      if (aiAnswer) {
        return {
          source: 'groq_ai',
          answer: aiAnswer
        };
      }
    } catch (error) {
      console.error('Groq AI error:', error.message);
    }
  }
  
  return {
    source: 'default',
    answer: getDefaultResponse(query)
  };
};

// ==================== GET KNOWLEDGE COUNT ====================
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

// ==================== BOT COMMANDS ====================

bot.start(async (ctx) => {
  let welcomeMsg;
  
  if (supabaseAvailable) {
    const knowledgeCount = await getKnowledgeCount();
    welcomeMsg = `Welcome! I'm your AI voice assistant with ${knowledgeCount} pieces of knowledge.\n\n` +
                `Send voice or text, and I'll reply from my knowledge base!\n\n` +
                `**Commands:**\n` +
                `/voiceai - Voice AI mode: /voiceai on or /voiceai off\n` +
                `/mode - Interactive menu to set voice/text/both modes\n` +
                `/ask - Force AI response: /ask [question]\n` +
                `/groqstatus - Check AI status\n` +
                `/add - Add knowledge: /add "question" || "answer"\n` +
                `/search - Search knowledge: /search [query]\n` +
                `/faq - Show frequently asked questions\n` +
                `/stats - Show bot statistics\n` +
                `/setmodel - Change AI model`;
  } else {
    welcomeMsg = 'Welcome! Send voice or text. (Knowledge base not available)';
    if (GROQ_CONFIG.enabled) {
      welcomeMsg += '\nGroq AI integration is enabled. Use /ask [question]';
    }
  }
  
  ctx.reply(welcomeMsg, { parse_mode: 'Markdown' });
});

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
      
      // ADDED: Generate voice response for document-based answers
      try {
        const voiceBuffer = await textToVoice(result.replace(/\*\*/g, '').replace(/`/g, ''));
        await ctx.replyWithVoice({ source: voiceBuffer });
      } catch (err) {
        console.error('Voice generation failed for document answer:', err.message);
      }
    } else {
      if (GROQ_CONFIG.enabled) {
        await ctx.reply('Not found in knowledge base. Asking AI...');
        const aiResponse = await queryGroqAI(query);
        if (aiResponse) {
          await ctx.reply(`<b>AI Response:</b>\n\n${aiResponse}`, { parse_mode: 'HTML' });
          
          // ADDED: Generate voice response for AI answers
          try {
            const voiceBuffer = await textToVoice(aiResponse.replace(/\*\*/g, '').replace(/`/g, ''));
            await ctx.replyWithVoice({ source: voiceBuffer });
          } catch (err) {
            console.error('Voice generation failed for AI answer:', err.message);
          }
        } else {
          const suggestions = await getRelatedSuggestions(query);
          let reply = `No exact match for "${query}"`;
          if (suggestions) {
            reply += `\n\n **Related topics:** ${suggestions}\n Try asking about one of these!`;
          }
          await ctx.reply(reply);
        }
      } else {
        const suggestions = await getRelatedSuggestions(query);
        let reply = `No exact match for "${query}"`;
        if (suggestions) {
          reply += `\n\n **Related topics:** ${suggestions}\n Try asking about one of these!`;
        }
        await ctx.reply(reply);
      }
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
      .limit(15);
    
    if (data && data.length > 0) {
      let response = '**Frequently Asked Questions**\n\n';
      const categories = {};
      
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
      
      if (GROQ_CONFIG.enabled) {
        response += '\n**AI:** `/ask [question]` or `/voiceai on`';
      }
      
      await ctx.reply(response, { parse_mode: 'Markdown' });
    } else {
      await ctx.reply('No FAQs yet. Be the first to add one!\n\n`/add "question" || "answer"`', { parse_mode: 'Markdown' });
    }
  } catch (err) {
    console.error('FAQ error:', err);
    await ctx.reply('Error loading FAQs.');
  }
});

bot.command('stats', async (ctx) => {
  const count = await getKnowledgeCount();
  
  let response = `**Knowledge Base Stats**\n\n` +
                 `• Total entries: ${count}\n` +
                 `• Voice model: ${transcriber ? 'Ready' : 'Loading'}\n` +
                 `• Supabase: ${supabaseAvailable ? 'Connected' : 'Disconnected'}\n` +
                 `• Groq AI: ${GROQ_CONFIG.enabled ? 'Enabled' : 'Disabled'}\n`;
  
  if (GROQ_CONFIG.enabled) {
    response += `• Current AI model: ${GROQ_CONFIG.defaultModel}\n`;
  }
  
  response += `• Last check: ${new Date().toLocaleTimeString()}\n\n` +
              `Use /faq to see available questions`;
  
  if (GROQ_CONFIG.enabled) {
    response += `\nUse /groqstatus for AI details`;
    response += `\nUse /mode to switch between KB and AI`;
  }
  
  await ctx.reply(response, { parse_mode: 'Markdown' });
});

// ==================== GROQ COMMANDS ====================

bot.command('ask', async (ctx) => {
  if (!GROQ_CONFIG.enabled) {
    return ctx.reply('Groq AI is not enabled. Please set GROQ_API_KEY in environment variables.');
  }
  
  const fullCommand = ctx.message.text.trim();
  let question = '';
  
  if (fullCommand.toLowerCase().startsWith('/ask ')) {
    question = fullCommand.replace(/^\/ask\s*/i, '').trim();
  } else {
    question = ctx.message.text.replace(/^\/ask/i, '').trim();
  }
  
  if (!question) {
    return ctx.reply('Usage: /ask [your question]\nExample: /ask What is machine learning?');
  }
  
  await ctx.reply('Thinking...');
  
  try {
    const aiResponse = await queryGroqAI(question);
    if (aiResponse) {
      await ctx.reply(`<b>AI Response:</b>\n\n${aiResponse}`, { parse_mode: 'HTML' });
      
      try {
        const voiceBuffer = await textToVoice(aiResponse.replace(/\*\*/g, '').replace(/`/g, ''));
        await ctx.replyWithVoice({ source: voiceBuffer });
      } catch (err) {
        console.error('Voice generation failed:', err.message);
      }
    } else {
      await ctx.reply('Sorry, I could not get a response from the AI service.');
    }
  } catch (err) {
    console.error('Ask command error:', err);
    await ctx.reply('Error getting AI response. Please try again.');
  }
});

bot.command('groqstatus', async (ctx) => {
  let response = '**Groq AI Status:**\n\n';
  
  response += `• Enabled: ${GROQ_CONFIG.enabled ? 'Yes' : 'No'}\n`;
  
  if (GROQ_CONFIG.enabled) {
    response += `• Current Model: ${GROQ_CONFIG.defaultModel}\n`;
    response += `• Available Models:\n`;
    
    GROQ_CONFIG.availableModels.forEach(model => {
      const isDefault = model === GROQ_CONFIG.defaultModel;
      response += `  • ${isDefault ? '✅ ' : ''}${model}\n`;
    });
    
    try {
      const testResponse = await axios.post(
        GROQ_CONFIG.endpoint,
        {
          model: GROQ_CONFIG.defaultModel,
          messages: [{ role: 'user', content: 'Say "OK" if working.' }],
          max_tokens: 10
        },
        {
          headers: {
            'Authorization': `Bearer ${GROQ_CONFIG.apiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );
      
      if (testResponse.data) {
        response += `\n• Connection: Working\n`;
      }
    } catch (error) {
      response += `\n• Connection: Failed - ${error.message.substring(0, 50)}\n`;
    }
  } else {
    response += `• To enable, add GROQ_API_KEY to your .env file\n`;
    response += `• Get API key from: https://console.groq.com\n`;
  }
  
  await ctx.reply(response, { parse_mode: 'Markdown' });
});

bot.command('setmodel', async (ctx) => {
  if (!GROQ_CONFIG.enabled) {
    return ctx.reply('Groq AI is not enabled.');
  }
  
  const modelName = ctx.message.text.replace(/^\/setmodel\s*/i, '').trim();
  
  if (!modelName) {
    let response = '**Available Groq Models:**\n\n';
    
    GROQ_CONFIG.availableModels.forEach(model => {
      const isDefault = model === GROQ_CONFIG.defaultModel;
      response += `• ${isDefault ? '✅ ' : ''}${model}\n`;
    });
    
    response += '\n**Usage:** `/setmodel [model_name]`\n';
    response += '**Example:** `/setmodel llama-3.1-8b-instant`';
    
    return ctx.reply(response, { parse_mode: 'Markdown' });
  }
  
  if (!GROQ_CONFIG.availableModels.includes(modelName)) {
    return ctx.reply(`Model "${modelName}" is not available. Use /setmodel to see available models.`);
  }
  
  GROQ_CONFIG.defaultModel = modelName;
  
  ctx.reply(`Model set to: **${modelName}**`, { parse_mode: 'Markdown' });
});

// ==================== VOICE AI COMMANDS ====================

bot.command('voiceai', async (ctx) => {
  if (!GROQ_CONFIG.enabled) {
    return ctx.reply('Groq AI is not enabled. Please set GROQ_API_KEY in environment variables.');
  }
  
  const fullCommand = ctx.message.text.trim();
  let mode = '';
  
  if (fullCommand.toLowerCase().startsWith('/voiceai ')) {
    mode = fullCommand.replace(/^\/voiceai\s*/i, '').trim().toLowerCase();
  } else if (fullCommand.toLowerCase().startsWith('/voiceaion')) {
    mode = 'on';
  } else if (fullCommand.toLowerCase().startsWith('/voiceaioff')) {
    mode = 'off';
  } else {
    mode = '';
  }
  
  if (!mode || (mode !== 'on' && mode !== 'off')) {
    const currentMode = ctx.session.voiceAIMode ? 'ON (AI mode)' : 'OFF (KB mode)';
    return ctx.reply(
      `Current voice AI mode: **${currentMode}**\n\n` +
      `**Usage:**\n` +
      `• \`/voiceai on\` - Voice queries use AI\n` +
      `• \`/voiceai off\` - Voice queries use KB first\n` +
      `• \`/voiceaion\` - Shortcut for /voiceai on\n` +
      `• \`/voiceaioff\` - Shortcut for /voiceai off\n\n` +
      `Use /mode to control both voice and text modes`,
      { parse_mode: 'Markdown' }
    );
  }
  
  if (mode === 'on') {
    ctx.session.voiceAIMode = true;
    ctx.reply(
      '✅ **Voice AI mode enabled!**\n\n' +
      'All voice queries will now use the external AI model.\n' +
      'Use `/voiceai off` or `/voiceaioff` to switch back to knowledge base mode.',
      { parse_mode: 'Markdown' }
    );
  } else {
    ctx.session.voiceAIMode = false;
    ctx.reply(
      '✅ **Voice AI mode disabled.**\n\n' +
      'Voice queries will now use the knowledge base first.\n' +
      'Use `/voiceai on` or `/voiceaion` to switch to AI mode.',
      { parse_mode: 'Markdown' }
    );
  }
});

bot.command('voiceaion', async (ctx) => {
  if (!GROQ_CONFIG.enabled) {
    return ctx.reply('Groq AI is not enabled. Please set GROQ_API_KEY in environment variables.');
  }
  
  ctx.session.voiceAIMode = true;
  ctx.reply(
    '✅ **Voice AI mode enabled!**\n\n' +
    'All voice queries will now use the external AI model.\n' +
    'Use `/voiceai off` or `/voiceaioff` to switch back to knowledge base mode.',
    { parse_mode: 'Markdown' }
  );
});

bot.command('voiceaioff', async (ctx) => {
  if (!GROQ_CONFIG.enabled) {
    return ctx.reply('Groq AI is not enabled. Please set GROQ_API_KEY in environment variables.');
  }
  
  ctx.session.voiceAIMode = false;
  ctx.reply(
    '✅ **Voice AI mode disabled.**\n\n' +
    'Voice queries will now use the knowledge base first.\n' +
    'Use `/voiceai on` or `/voiceaion` to switch to AI mode.',
    { parse_mode: 'Markdown' }
  );
});

bot.command('mode', async (ctx) => {
  if (!GROQ_CONFIG.enabled) {
    return ctx.reply('Groq AI is not enabled. Please set GROQ_API_KEY in environment variables.');
  }
  
  const currentVoiceMode = ctx.session.voiceAIMode ? 'ON (AI mode)' : 'OFF (KB mode)';
  const currentTextMode = ctx.session.textAIMode ? 'ON (AI mode)' : 'OFF (KB mode)';
  
  const inlineKeyboard = {
    inline_keyboard: [
      [
        { text: 'Voice: KB Mode', callback_data: 'mode_voice_kb' },
        { text: 'Voice: AI Mode', callback_data: 'mode_voice_ai' }
      ],
      [
        { text: 'Text: KB Mode', callback_data: 'mode_text_kb' },
        { text: 'Text: AI Mode', callback_data: 'mode_text_ai' }
      ],
      [
        { text: 'Both: KB Mode', callback_data: 'mode_both_kb' },
        { text: 'Both: AI Mode', callback_data: 'mode_both_ai' }
      ]
    ]
  };
  
  await ctx.reply(
    `**Current Modes:**\n` +
    `• Voice: ${currentVoiceMode}\n` +
    `• Text: ${currentTextMode}\n\n` +
    `Select your preferred mode:`,
    { reply_markup: inlineKeyboard, parse_mode: 'Markdown' }
  );
});

// ==================== DOCUMENT UPLOAD HANDLER ====================

bot.on('document', async (ctx) => {
  const document = ctx.message.document;
  const mimeType = document.mime_type;
  const fileName = document.file_name || 'document';
  const fileSize = document.file_size;
  
  const MAX_FILE_SIZE = 10 * 1024 * 1024;
  if (fileSize && fileSize > MAX_FILE_SIZE) {
    const sizeMB = (fileSize / 1024 / 1024).toFixed(1);
    return ctx.reply(
      `File too large: ${sizeMB}MB.\n` +
      `Maximum file size: 10MB.\n` +
      `Please send a smaller file or compress the PDF.`
    );
  }
  
  const supportedTypes = {
    'application/pdf': 'pdf',
    'text/plain': 'txt'
  };
  
  const fileType = supportedTypes[mimeType];
  if (!fileType) {
    return ctx.reply(`Unsupported file type: ${mimeType}. I support PDF and TXT files.`);
  }
  
  await ctx.reply(`Processing ${fileName}...`);
  
  try {
    const file = await ctx.telegram.getFile(document.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
    
    console.log(`Downloading document: ${fileName}, Type: ${fileType}, Size: ${fileSize} bytes`);
    
    const response = await axios.get(fileUrl, { 
      responseType: 'arraybuffer',
      timeout: 30000,
      maxContentLength: MAX_FILE_SIZE
    });
    
    const fileBuffer = Buffer.from(response.data);
    
    console.log(`Downloaded ${fileBuffer.length} bytes, processing...`);
    
    const { text, originalLength, info, wasTruncated } = await processDocument(fileBuffer, fileType, fileName);
    
    let statusMessage = `Successfully processed ${fileName}\n`;
    statusMessage += `Extracted ${originalLength.toLocaleString()} characters`;
    
    if (info.numPages) {
      statusMessage += ` from ${info.numPages} page${info.numPages === 1 ? '' : 's'}`;
    }
    
    if (wasTruncated) {
      statusMessage += `\nNote: Document was truncated to ${text.length.toLocaleString()} characters for processing`;
    }
    
    await ctx.reply(statusMessage);
    
    const userId = ctx.from.id;
    ctx.session.userId = userId;
    ctx.session.documentText = text;
    ctx.session.documentName = fileName;
    ctx.session.documentTimestamp = Date.now();
    
    const inlineKeyboard = {
      inline_keyboard: [
        [
          { text: 'Ask a question', callback_data: 'doc_ask' }
        ],
        [
          { text: 'Summarize', callback_data: 'doc_summarize' },
          { text: 'Save to KB', callback_data: 'doc_save' }
        ],
        [
          { text: 'Extract key info', callback_data: 'doc_extract' }
        ]
      ]
    };
    
    await ctx.reply(
      `What would you like to do with "${fileName}"?`,
      { reply_markup: inlineKeyboard }
    );
    
  } catch (error) {
    console.error('Document processing error:', error.message);
    
    let errorMessage = `Error processing "${fileName}":\n\n`;
    
    if (error.message.includes('scanned') || error.message.includes('image-based')) {
      errorMessage += `This appears to be a scanned PDF (image-based).\n\n` +
                     `I can only extract text from searchable PDFs.\n` +
                     `To make it searchable:\n` +
                     `• Use Adobe Acrobat's OCR feature\n` +
                     `• Or use online tools like ilovepdf.com\n` +
                     `• Or take a screenshot and use image-to-text tools`;
    } else if (error.message.includes('Invalid PDF')) {
      errorMessage += `The file appears to be corrupted or not a valid PDF.\n\n` +
                     `Please check the file and try again, or send a different file.`;
    } else if (error.message.includes('large')) {
      errorMessage += `File too large.\n\n` +
                     `Maximum size: 10MB\n` +
                     `Try compressing the PDF or splitting it into smaller files.`;
    } else {
      errorMessage += `${error.message}\n\n` +
                     `Please ensure it's a valid PDF or text file and try again.`;
    }
    
    await ctx.reply(errorMessage);
  }
});

// ==================== CALLBACK QUERY HANDLER ====================

bot.on('callback_query', async (ctx) => {
  const callbackData = ctx.callbackQuery.data;
  const messageId = ctx.callbackQuery.message.message_id;
  const userId = ctx.callbackQuery.from.id;
  
  await ctx.answerCbQuery();
  
  try {
    await ctx.deleteMessage(messageId);
  } catch (err) {
    console.log('Could not delete message:', err.message);
  }
  
  if (callbackData.startsWith('mode_')) {
    const parts = callbackData.split('_');
    const target = parts[1];
    const mode = parts[2];
    
    if (target === 'voice' || target === 'both') {
      ctx.session.voiceAIMode = (mode === 'ai');
    }
    
    if (target === 'text' || target === 'both') {
      ctx.session.textAIMode = (mode === 'ai');
    }
    
    const voiceMode = ctx.session.voiceAIMode ? 'AI Mode' : 'KB Mode';
    const textMode = ctx.session.textAIMode ? 'AI Mode' : 'KB Mode';
    
    await ctx.reply(
      `✅ Mode updated!\n\n` +
      `• Voice queries: **${voiceMode}**\n` +
      `• Text queries: **${textMode}**\n\n` +
      `Use /voiceai on/off for voice-only control\n` +
      `Use /mode to change again`,
      { parse_mode: 'Markdown' }
    );
    
    return;
  }
  
  if (callbackData.startsWith('doc_')) {
    if (ctx.session.userId !== userId) {
      await ctx.reply('Session expired. Please upload the document again.');
      return;
    }
    
    if (!ctx.session.documentText) {
      await ctx.reply('Document context lost. Please upload the document again.');
      return;
    }
    
    const docText = ctx.session.documentText;
    const docName = ctx.session.documentName || 'the document';
    
    switch (callbackData) {
      case 'doc_ask':
        await ctx.reply(`Please ask your question about "${docName}":`);
        ctx.session.waitingForQuestion = true;
        break;
        
      case 'doc_summarize':
        await ctx.reply(`Creating summary of "${docName}"...`);
        
        try {
          const summary = await queryGroqAI(
            `Please summarize the following document content in 3-5 key bullet points:\n\n` +
            `DOCUMENT CONTENT:\n${docText}\n\n` +
            `Provide a concise summary of the main points.`
          );
          
          if (summary) {
            await ctx.reply(`<b>Summary of ${docName}:</b>\n\n${summary}`, { parse_mode: 'HTML' });
            
            // ADDED: Generate voice response for document summary
            try {
              const voiceBuffer = await textToVoice(summary.replace(/\*\*/g, '').replace(/`/g, ''));
              await ctx.replyWithVoice({ source: voiceBuffer });
            } catch (err) {
              console.error('Voice generation failed for document summary:', err.message);
            }
          } else {
            await ctx.reply('Could not generate summary. AI service unavailable.');
          }
        } catch (error) {
          console.error('Summary generation error:', error);
          await ctx.reply('Error generating summary. Please try again.');
        }
        
        delete ctx.session.documentText;
        delete ctx.session.documentName;
        delete ctx.session.documentTimestamp;
        break;
        
      case 'doc_save':
        if (supabaseAvailable) {
          try {
            const question = `Content from: ${docName}`;
            const answer = `Document: ${docName}\n\nKey content:\n${docText.substring(0, 3000)}${docText.length > 3000 ? '...' : ''}`;
            
            const { result } = await addKnowledge(`${question} || ${answer}`);
            
            await ctx.reply(`Document saved to knowledge base!\n\n${result}`);
          } catch (error) {
            console.error('Save to KB error:', error);
            await ctx.reply('Error saving to knowledge base. Please try again.');
          }
        } else {
          await ctx.reply('Knowledge base unavailable.');
        }
        
        delete ctx.session.documentText;
        delete ctx.session.documentName;
        delete ctx.session.documentTimestamp;
        break;
        
      case 'doc_extract':
        await ctx.reply(`Extracting key information from "${docName}"...`);
        
        try {
          const keyInfo = await queryGroqAI(
            `Extract the most important information from this document content:\n\n` +
            `DOCUMENT CONTENT:\n${docText}\n\n` +
            `Please provide:\n` +
            `1. Main topics/subjects\n` +
            `2. Key dates/numbers\n` +
            `3. Important names/organizations\n` +
            `4. Main conclusions/recommendations`
          );
          
          if (keyInfo) {
            await ctx.reply(`<b>Key Information from ${docName}:</b>\n\n${keyInfo}`, { parse_mode: 'HTML' });
            
            // ADDED: Generate voice response for extracted key info
            try {
              const voiceBuffer = await textToVoice(keyInfo.replace(/\*\*/g, '').replace(/`/g, ''));
              await ctx.replyWithVoice({ source: voiceBuffer });
            } catch (err) {
              console.error('Voice generation failed for key info:', err.message);
            }
          } else {
            await ctx.reply('Could not extract key information. AI service unavailable.');
          }
        } catch (error) {
          console.error('Key info extraction error:', error);
          await ctx.reply('Error extracting information. Please try again.');
        }
        
        delete ctx.session.documentText;
        delete ctx.session.documentName;
        delete ctx.session.documentTimestamp;
        break;
    }
  }
});

// ==================== MESSAGE HANDLERS ====================

const processedMessages = new Set();
const MAX_PROCESSED_IDS = 1000;

bot.on('voice', async (ctx) => {
  const messageId = ctx.message.message_id;
  
  if (processedMessages.has(messageId)) {
    console.log(`Skipping already processed voice message ${messageId}`);
    return;
  }
  
  processedMessages.add(messageId);
  if (processedMessages.size > MAX_PROCESSED_IDS) {
    const firstId = processedMessages.values().next().value;
    processedMessages.delete(firstId);
  }
  
  try {
    await ctx.reply('Processing...');
    
    const file = await ctx.telegram.getFile(ctx.message.voice.file_id);
    const audioUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
    
    const audioFloat32 = await decodeAudioToFloat32(audioUrl);
    
    const model = await loadTranscriber();
    const result = await processWithTimeout(
      () => model(audioFloat32),
      'Speech Recognition',
      30000
    );
    
    const userText = result.text?.trim() || '';
    
    if (!userText) {
      await ctx.reply('Could not understand the audio. Please try again.');
      return;
    }
    
    await ctx.reply(`**You said:** ${userText}`, { parse_mode: 'Markdown' });
    
    if (supabaseAvailable) {
      await saveTranscript(ctx.from?.id, userText, 'voice');
    }

    const useAI = ctx.session.voiceAIMode || false;
    
    const response = await enhancedFindAnswer(userText, useAI);
    
    const sourceLabel = response.source === 'knowledge_base' ? 'Knowledge Base' : 
                       response.source === 'groq_ai' ? 'AI Response' : 'Default';
    
    await ctx.reply(`**${sourceLabel}:**\n\n${response.answer}`, { parse_mode: 'Markdown' });

    try {
      const voiceBuffer = await textToVoice(response.answer.replace(/\*\*/g, '').replace(/`/g, ''));
      await ctx.replyWithVoice({ source: voiceBuffer });
    } catch (err) {
      console.error('Voice generation failed:', err.message);
    }
    
  } catch (error) {
    console.error('Voice handler error:', error.message);
    await ctx.reply('Error processing voice message. Please try again.');
  }
});

bot.on('text', async (ctx) => {
  const messageId = ctx.message.message_id;
  const userText = ctx.message.text?.trim();
  const userId = ctx.from.id;
  
  if (!userText || userText.startsWith('/')) return;
  
  if (ctx.session && ctx.session.waitingForQuestion && ctx.session.userId === userId) {
    const question = userText;
    const docText = ctx.session.documentText;
    const docName = ctx.session.documentName || 'the document';
    
    delete ctx.session.waitingForQuestion;
    
    await ctx.reply('Thinking about your question...');
    
    try {
      const answer = await queryGroqAI(
        `Based on the following document content:\n\n` +
        `DOCUMENT CONTENT:\n${docText}\n\n` +
        `Question: ${question}\n\n` +
        `Answer:`
      );
      
      if (answer) {
        await ctx.reply(`<b>Answer:</b>\n\n${answer}`, { parse_mode: 'HTML' });
        
        // ADDED: Generate voice response for document question answers
        try {
          const voiceBuffer = await textToVoice(answer.replace(/\*\*/g, '').replace(/`/g, ''));
          await ctx.replyWithVoice({ source: voiceBuffer });
        } catch (err) {
          console.error('Voice generation failed for document answer:', err.message);
        }
      } else {
        await ctx.reply('Could not answer question. AI service unavailable.');
      }
    } catch (error) {
      await ctx.reply('Error answering question.');
    }
    
    delete ctx.session.documentText;
    delete ctx.session.documentName;
    delete ctx.session.documentTimestamp;
    return;
  }
  
  if (processedMessages.has(messageId)) {
    console.log(`Skipping already processed text message ${messageId}`);
    return;
  }
  
  processedMessages.add(messageId);
  if (processedMessages.size > MAX_PROCESSED_IDS) {
    const firstId = processedMessages.values().next().value;
    processedMessages.delete(firstId);
  }

  if (supabaseAvailable) {
    await saveTranscript(ctx.from?.id, userText, 'text');
  }

  const useAI = ctx.session.textAIMode || false;
  
  const response = await enhancedFindAnswer(userText, useAI);
  
  const sourceLabel = response.source === 'knowledge_base' ? 'Knowledge Base' : 
                     response.source === 'groq_ai' ? 'AI Response' : 'Default';
  
  await ctx.reply(`**${sourceLabel}:**\n\n${response.answer}`, { parse_mode: 'Markdown' });

  try {
    const voiceBuffer = await textToVoice(response.answer.replace(/\*\*/g, '').replace(/`/g, ''));
    await ctx.replyWithVoice({ source: voiceBuffer });
  } catch (err) {
    console.error('Voice generation failed:', err.message);
  }
});

// ==================== CRASH PREVENTION ====================

bot.use(async (ctx, next) => {
  if (isShuttingDown) {
    await ctx.reply('Bot is restarting. Please try again in a moment.');
    return;
  }
  
  if (activeRequests >= SAFETY_CONFIG.REQUEST_QUEUE_SIZE) {
    await ctx.reply('Bot is busy. Please try again in a moment.');
    return;
  }
  
  await next();
});

bot.catch((err, ctx) => {
  console.error('Bot error:', err);
  
  try {
    ctx.reply('An error occurred. Please try again.').catch(() => {});
  } catch (e) {}
});

process.on('uncaughtException', (error) => {
  console.error('UNCAUGHT EXCEPTION:', error);
  gracefulShutdown('uncaught_exception');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('UNHANDLED REJECTION at:', promise, 'reason:', reason);
  gracefulShutdown('unhandled_rejection');
});

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

const gracefulShutdown = async (reason = 'unknown') => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  console.log(`Initiating graceful shutdown: ${reason}`);
  console.log(`Active requests: ${activeRequests}`);
  
  while (requestQueue.length > 0) {
    const { reject } = requestQueue.shift();
    reject(new Error('Bot is shutting down'));
  }
  
  const shutdownTimeout = setTimeout(() => {
    console.log('Shutdown timeout forced');
    process.exit(1);
  }, 10000);
  
  try {
    if (bot && bot.stop) {
      await bot.stop();
      console.log('Bot stopped accepting requests');
    }
    
    while (activeRequests > 0) {
      console.log(`Waiting for ${activeRequests} active requests...`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    clearTimeout(shutdownTimeout);
    console.log('Graceful shutdown complete');
    process.exit(0);
  } catch (err) {
    console.error('Error during shutdown:', err);
    process.exit(1);
  }
};

// ==================== BOT STARTUP ====================

const startBot = async () => {
  try {
    processedMessages.clear();
    
    console.log('Starting bot with crash protection...');
    console.log(`Memory limit: ${SAFETY_CONFIG.MAX_MEMORY_MB}MB`);
    console.log(`Request limit: ${SAFETY_CONFIG.REQUEST_QUEUE_SIZE} concurrent`);
    console.log(`Timeout: ${SAFETY_CONFIG.MAX_REQUEST_TIME}ms per request`);
    
    await bot.launch();
    console.log('Bot started successfully');
    
  } catch (err) {
    console.error('Failed to start bot:', err);
    
    setTimeout(startBot, 5000);
  }
};

startBot();