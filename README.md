# VoxNote — Brief Overview
VoxNote is a lightweight Telegram bot that provides voice-first conversational AI support. It transcribes voice messages, searches a knowledge base for answers, and replies with both text and voice responses—perfect for customer support, FAQs, and interactive assistance.

# Core Features
Voice-to-Text Transcription: Uses Whisper AI to transcribe voice messages with high accuracy

Text-to-Speech Replies: Converts responses to natural-sounding voice messages

Knowledge Base Integration: Stores and retrieves information from Supabase PostgreSQL

Smart Matching: Understands natural language with synonym and context-aware matching

Learnable: Add new knowledge dynamically with /add command

Real-time Responses: Instant voice+text replies for seamless interaction

# Architecture
### How It Works
Voice Input: User sends voice message via Telegram

Transcription: Whisper AI converts speech to text (offline-capable)

Knowledge Search: Bot searches Supabase for relevant answers using smart matching algorithms

Response Generation: Retrieves answer or provides helpful default response

Voice Output: gTTS converts text response to voice message

Delivery: Sends both text and voice replies to user
 
### Tech Stack
Bot Framework: Telegraf.js (Telegram Bot API)

Speech Recognition: @xenova/transformers (Whisper Tiny)

Speech Synthesis: gTTS (Google Text-to-Speech)

Database: Supabase (PostgreSQL)

Audio Processing: FFmpeg

Fetch: Node.js fetch/undici

# Quick start
## Installation
### Clone repository
git clone <repo>
cd <repo-path>

### Install dependencies
npm install

### Copy environment template
cp .env.example .env
Configuration
Edit .env file with your credentials:

env
### Telegram Bot
BOT_TOKEN=your_telegram_bot_token_here
- `BOT_TOKEN` — Token for the chat/bot platform your bot connects to.
	- Telegram: create a bot with @BotFather and copy the token it returns.
   
### Supabase Database
EXPO_PUBLIC_SUPABASE_URL=your_supabase_project_url
- `EXPO_PUBLIC_SUPABASE_URL` — Find it in your Supabase project → Settings → API (Project URL).
  
EXPO_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
- `EXPO_PUBLIC_SUPABASE_ANON_KEY` — Find it in Supabase → Settings → API (anon/public key).
  
### Optional: FFmpeg path (if not in system PATH)
 FFMPEG_PATH=/usr/bin/ffmpeg

## Database Setup
Create a Supabase project

Run this SQL in the Supabase SQL Editor:

sql
CREATE TABLE knowledge_base (
  id BIGSERIAL PRIMARY KEY,
  question TEXT,
  answer TEXT,
  content TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_kb_question ON knowledge_base(question);
CREATE INDEX idx_kb_content ON knowledge_base(content);

# Running the Bot
bash
## What works for me locally
node bot.js

## Development mode
npm run dev

## Production mode
npm start

# Bot Commands
## Command	Description	Example
/start	Welcome message and instructions	/start
/add	Add knowledge to database	`/add What are your hours?		24/7 support available!`
/search	Search knowledge base	/search refund policy
/faq	Show frequently asked questions	/faq
/stats	Show bot statistics	/stats

# Usage Examples
### Voice Interaction
User: "Hello, how do I reset my password?"

Bot: "To reset your password, click 'Forgot Password' on the login page and check your email for a reset link." +  (same text)

### Text Interaction
User: "What's your refund policy?"

Bot: *"We offer 30-day refunds for all purchases. Contact billing@example.com for assistance."* + (voice version)

# Privacy & Data
VoxNote may store transcribed text and audio. Treat data as user content — secure storage and access controls are recommended when deploying in production.

# Troubleshooting
- If transcription fails, verify API key and network access.
- If notes are not saved, check storage path permissions.

# Contributing
Small, focused contributions are welcome. Open issues or PRs for bug fixes and improvements.

