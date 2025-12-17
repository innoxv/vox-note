## VoxNote — Brief Overview

VoxNote is a lightweight telegram bot that helps record, index, and retrieve short voice-driven notes. It is designed to capture spoken ideas or quick reminders, attach simple metadata, and provide easy ways to list or search those notes later.

### What it does
- Accepts or records short voice notes (audio or transcribed text).
- Stores notes with basic metadata (timestamp, optional tags, and source).
- Provides simple retrieval: list recent notes, search by keyword or tag, and export notes.

### How it works (high-level)
1. Input: the bot receives a note as audio or text (e.g. via CLI, API, or chat hook).
2. Transcription: audio is transcribed to text using a configured speech-to-text engine.
3. Storage: the note text and metadata are persisted (file, database, or cloud storage depending on config).
4. Retrieval: users can query the bot to list, search, or export notes. Search is keyword/tag-based.

### Quick start
1. Install dependencies: see `package.json` for required packages.
2. Configure any necessary API keys or storage paths (environment variables or a config file).
3. Run the bot: `node bot.js`.

### Configuration
- Check `package.json` and `bot.js` for runtime options.
- Typical settings: transcription provider API key, storage backend path/URI, default tags.

### Required environment variables
This project uses a few environment variables; fill them in by copying `.env.example` to `.env` and replacing the placeholders.

- `GROQ_API_KEY` — API token used for GROQ queries 

- `BOT_TOKEN` — Token for the chat/bot platform your bot connects to.
	- Telegram: create a bot with @BotFather and copy the token it returns.

- `EXPO_PUBLIC_SUPABASE_URL` — If using Supabase for storage/auth, this is your project's public URL. Find it in your Supabase project → Settings → API (Project URL).

- `EXPO_PUBLIC_SUPABASE_ANON_KEY` — Supabase project's anon (public) key used by client-side code. Find it in Supabase → Settings → API (anon/public key).

Security note: `.env` contains secrets. Do not commit it to source control. Use environment-specific secrets management for production (secret manager, environment variables on the host, or CI/CD secret store).

### Privacy & Data
VoxNote may store transcribed text and audio. Treat data as user content — secure storage and access controls are recommended when deploying in production.

### Troubleshooting
- If transcription fails, verify API key and network access.
- If notes are not saved, check storage path permissions.

### Contributing
Small, focused contributions are welcome. Open issues or PRs for bug fixes and improvements.

