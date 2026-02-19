# J.A.R.V.I.S. WhatsApp Bot

A powerful WhatsApp bot powered by multiple AI models (Gemini, Groq, OpenRouter).

## Features
- Interactive chat using advanced LLMs.
- Multi-model support: Google Gemini, Groq (Llama), and OpenRouter.
- Personality-driven responses (J.A.R.V.I.S. persona).
- Persistent memory and context awareness.
- Integration with external tools (Web Search, Weather, Shell).

## Setup
1. Clone the repository.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create a `.env` file and add your API keys:
   ```env
   GEMINI_API_KEY=your_gemini_key
   GROQ_API_KEY=your_groq_key
   OPENROUTER_API_KEY=your_openrouter_key
   ```
4. Start the bot:
   ```bash
   ./start.sh
   ```

## Technologies
- Node.js
- [Baileys](https://github.com/WhiskeySockets/Baileys) (WhatsApp Web API)
- Google Generative AI SDK
- Groq SDK
- OpenRouter API
