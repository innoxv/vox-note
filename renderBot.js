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

const bot = new Telegraf(process.env.BOT_TOKEN, {
  telegram: {
    // Optimize for memory
    agent: null,
    timeout: 10000
  }
});

// ==================== MEMORY OPTIMIZATION ====================

let transcriber = null;
let isModelLoading = false;
let modelLoadQueue = [];

// Lazy load Whisper model to save memory
const loadTranscriber = async () => {
  if (transcriber) return transcriber;
  
  if (isModelLoading) {
    // Wait for model to load if another request is loading it
    return new Promise(resolve => {
      modelLoadQueue.push(resolve);
    });
  }
  
  isModelLoading = true;
  console.log('Loading Whisper model (lazy load)...');
  
  try {
    // Use smaller batch size to reduce memory
    transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', {
      device: 'cpu',
      quantized: true
    });
    
    console.log('Whisper model loaded');
    
    // Resolve all waiting requests
    while (modelLoadQueue.length) {
      const resolve = modelLoadQueue.shift();
      resolve(transcriber);
    }
    
    return transcriber;
  } catch (error) {
    console.error('Failed to load Whisper model:', error);
    isModelLoading = false;
    throw error;
  } finally {
    isModelLoading = false;
  }
};

// Memory cleanup helper
const cleanupMemory = () => {
  if (global.gc) {
    try {
      global.gc();
      console.log('Garbage collection forced');
    } catch (e) {
      console.log('Garbage collection failed:', e.message);
    }
  }
  
  // Clear any cached data
  if (transcriber && transcriber.model) {
    // Clear model cache if possible
    try {
      transcriber.model.dispose && transcriber.model.dispose();
    } catch (e) {
      // Ignore
    }
  }
};

// ==================== HEALTH CHECK ====================

app.get('/health', (req, res) => {
  const memory = process.memoryUsage();
  const heapUsedMB = Math.round(memory.heapUsed / 1024 / 1024);
  const heapTotalMB = Math.round(memory.heapTotal / 1024 / 1024);
  
  res.json({
    status: 'ok',
    service: 'voice-support-bot',
    timestamp: new Date().toISOString(),
    memory: {
      heapUsed: heapUsedMB + 'MB',
      heapTotal: heapTotalMB + 'MB',
      rss: Math.round(memory.rss / 1024 / 1024) + 'MB'
    },
    supabase: supabaseAvailable ? 'connected' : 'disconnected',
    whisper: transcriber ? 'loaded' : 'not-loaded'
  });
});

// ==================== SIMPLIFIED MATCHING ====================

const findInSupabase = async (query) => {
  if (!supabaseAvailable) return null;
  
  try {
    const q = query.trim().toLowerCase();
    
    // Simple exact match first
    const { data, error } = await supabase
      .from('knowledge_base')
      .select('question, answer')
      .ilike('question', q)
      .limit(1);
    
    if (error) throw error;
    if (data && data.length > 0) {
      return data[0].answer;
    }
    
    // Simple content search
    const { data: contentData } = await supabase
      .from('knowledge_base')
      .select('answer')
      .ilike('answer', `%${q}%`)
      .limit(1);
    
    if (contentData && contentData.length > 0) {
      return contentData[0].answer;
    }
    
    return null;
  } catch (err) {
    console.error('Supabase lookup error:', err.message);
    return null;
  }
};

const getDefaultResponse = (query) => {
  return `I don't have information about "${query}" yet. You can add it with: /add "${query}" || [your answer here]`;
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
  
  const { error } = await supabase
    .from('knowledge_base')
    .insert([{ 
      question,
      answer,
      content: answer,
      created_at: new Date().toISOString()
    }]);
  
  if (error) {
    // Try update if exists
    const { error: updateError } = await supabase
      .from('knowledge_base')
      .update({ 
        answer,
        content: answer,
        updated_at: new Date().toISOString()
      })
      .eq('question', question);
    
    if (updateError) throw updateError;
    return `Updated: "${question}"`;
  }
  
  return `Added: "${question}"`;
};

// ==================== OPTIMIZED AUDIO PROCESSING ====================

const decodeAudioToFloat32 = async (url) => {
  const response = await fetch(url, { timeout: 10000 });
  const arrayBuffer = await response.arrayBuffer();
  
  const ffmpeg = spawn('ffmpeg', [
    '-i', 'pipe:0',
    '-f', 'f32le',
    '-ar', '16000',
    '-ac', '1',
    '-hide_banner',
    '-loglevel', 'error',
    '-t', '30', // Limit to 30 seconds max
    'pipe:1'
  ], {
    stdio: ['pipe', 'pipe', 'pipe']
  });
  
  ffmpeg.stdin.end(Buffer.from(arrayBuffer));
  
  const chunks = [];
  let stderr = '';
  
  ffmpeg.stdout.on('data', chunk => chunks.push(chunk));
  ffmpeg.stderr.on('data', data => stderr += data.toString());
  
  await new Promise((resolve, reject) => {
    ffmpeg.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`FFmpeg error: ${stderr}`));
      }
      resolve();
    });
    ffmpeg.on('error', reject);
  });
  
  const buffer = Buffer.concat(chunks);
  // Free memory immediately
  chunks.length = 0;
  
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
};

const textToVoice = async (text) => {
  return new Promise((resolve, reject) => {
    const tts = new gTTS(text.substring(0, 500), 'en'); // Limit text length
    
    const tempDir = isProduction ? '/tmp' : path.join(__dirname, 'temp');
    const tempFile = path.join(tempDir, `tts-${Date.now()}.mp3`);
    
    // Ensure temp directory exists
    if (!fs.existsSync(tempDir)) {
      try {
        fs.mkdirSync(tempDir, { recursive: true });
      } catch (err) {
        return reject(err);
      }
    }
    
    tts.save(tempFile, (err) => {
      if (err) return reject(err);
      
      fs.readFile(tempFile, (readErr, data) => {
        // Always cleanup temp file
        fs.unlink(tempFile, (unlinkErr) => {
          if (unlinkErr) console.error('Failed to delete temp file:', unlinkErr);
        });
        
        if (readErr) return reject(readErr);
        resolve(data);
      });
    });
  });
};

// ==================== SIMPLIFIED BOT COMMANDS ====================

bot.start((ctx) => {
  ctx.reply('Welcome to Voice Support Bot. Send voice or text messages.');
});

bot.command('add', async (ctx) => {
  if (!supabaseAvailable) {
    return ctx.reply('Knowledge base unavailable.');
  }
  
  const payload = ctx.message.text.replace(/^\/add\s*/i, '').trim();
  if (!payload) {
    return ctx.reply('Usage: /add "question" || "answer"');
  }
  
  try {
    const result = await addKnowledge(payload);
    ctx.reply(result);
  } catch (err) {
    console.error('Add error:', err);
    ctx.reply(`Error: ${err.message}`);
  }
});

bot.command('search', async (ctx) => {
  if (!supabaseAvailable) {
    return ctx.reply('Knowledge base unavailable.');
  }
  
  const query = ctx.message.text.replace(/^\/search\s*/i, '').trim();
  if (!query) {
    return ctx.reply('Usage: /search query');
  }
  
  try {
    const result = await findInSupabase(query);
    if (result) {
      await ctx.reply(`Found:\n${result}`);
    } else {
      await ctx.reply(`No match found for "${query}"`);
    }
  } catch (err) {
    console.error('Search error:', err);
    await ctx.reply('Error searching.');
  }
});

// ==================== OPTIMIZED MESSAGE HANDLERS ====================

bot.on('voice', async (ctx) => {
  await ctx.reply('Processing voice message...');

  try {
    const file = await ctx.telegram.getFile(ctx.message.voice.file_id);
    const audioUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;

    const audioFloat32 = await decodeAudioToFloat32(audioUrl);
    
    // Load model only when needed
    const model = await loadTranscriber();
    const result = await model(audioFloat32);
    const userText = result.text?.trim() || 'Could not understand';
    
    // Free audio buffer immediately
    audioFloat32 = null;
    
    // Optional: force garbage collection
    if (isProduction) cleanupMemory();
    
    await ctx.reply(`Transcribed: ${userText}`);
    
    let replyText;
    if (supabaseAvailable) {
      const kbAnswer = await findInSupabase(userText);
      replyText = kbAnswer || getDefaultResponse(userText);
    } else {
      replyText = getDefaultResponse(userText);
    }
    
    // Send text reply first
    await ctx.reply(replyText);
    
    // Then send voice (optional, can be disabled to save memory)
    try {
      const voiceBuffer = await textToVoice(replyText);
      await ctx.replyWithVoice({ source: voiceBuffer });
      
      // Free voice buffer
      voiceBuffer = null;
    } catch (err) {
      console.log('Voice synthesis skipped or failed:', err.message);
      // Continue without voice
    }
    
  } catch (err) {
    console.error('Voice processing error:', err.message);
    await ctx.reply('Error processing voice. Please try shorter message.');
  }
});

bot.on('text', async (ctx) => {
  const userText = ctx.message.text.trim();
  if (userText.startsWith('/')) return;

  let replyText;
  if (supabaseAvailable) {
    const kbAnswer = await findInSupabase(userText);
    replyText = kbAnswer || getDefaultResponse(userText);
  } else {
    replyText = getDefaultResponse(userText);
  }

  await ctx.reply(replyText);
  
  try {
    const voiceBuffer = await textToVoice(replyText);
    await ctx.replyWithVoice({ source: voiceBuffer });
  } catch (err) {
    console.log('Voice synthesis failed for text:', err.message);
  }
  
});

// ==================== DEPLOYMENT ====================

if (isProduction) {
  // Production with webhook
  const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
  
  if (!RENDER_URL) {
    console.error('RENDER_EXTERNAL_URL not set in production');
    process.exit(1);
  }
  
  const webhookPath = `/bot${process.env.BOT_TOKEN}`;
  const webhookUrl = `${RENDER_URL}${webhookPath}`;
  
  console.log(`Setting webhook: ${webhookUrl}`);
  
  // Set webhook with retry
  const setWebhookWithRetry = async (retries = 3) => {
    for (let i = 0; i < retries; i++) {
      try {
        await bot.telegram.setWebhook(webhookUrl);
        console.log('Webhook set successfully');
        return true;
      } catch (err) {
        console.error(`Webhook attempt ${i + 1} failed:`, err.message);
        if (i < retries - 1) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }
    return false;
  };
  
  setWebhookWithRetry().then(success => {
    if (success) {
      app.use(bot.webhookCallback(webhookPath));
      
      app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
        console.log(`Health check: ${RENDER_URL}/health`);
        console.log(`Webhook: ${webhookUrl}`);
      });
    } else {
      console.error('Failed to set webhook after retries');
      process.exit(1);
    }
  });
} else {
  // Development with polling
  bot.launch().then(() => {
    console.log('Bot running in development mode (polling)');
  }).catch(err => {
    console.error('Failed to start bot:', err.message);
  });
}

// Graceful shutdown
process.once('SIGINT', () => {
  console.log('Shutting down...');
  bot.stop('SIGINT');
  process.exit(0);
});

process.once('SIGTERM', () => {
  console.log('Shutting down...');
  bot.stop('SIGTERM');
  process.exit(0);
});

// Memory monitoring
if (isProduction) {
  setInterval(() => {
    const memory = process.memoryUsage();
    const heapUsedMB = memory.heapUsed / 1024 / 1024;
    
    if (heapUsedMB > 250) {
      console.warn(`High memory: ${heapUsedMB.toFixed(1)}MB`);
      cleanupMemory();
    }
    
    // Log memory every 5 minutes
    console.log(`Memory usage: ${heapUsedMB.toFixed(1)}MB`);
  }, 300000); // 5 minutes
}