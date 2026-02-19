# WhatsApp AI Assistant 🤖

A sophisticated, personality-driven WhatsApp assistant powered by Groq's LLM. It isn't just an assistant that chats; it's a capable AI that can search the web, check weather, set reminders, and even run shell commands on your machine.

## ✨ Features

- **Brainy**: Powered by Llama 3.3 70B (via Groq) for chat and Llama 3.2 Vision for image understanding.
- **Personality**: Sophisticated J.A.R.V.I.S. persona (witty, helpful, and "Sir"-focused).
- **Multimodal**: Handles text, images, stickers, and voice notes (transcribed on the fly via Whisper).
- **Memory**: Remembers facts about you and global preferences across conversations.
- **Tool Use**: Real-time web search, weather lookups, reminders, and shell command execution.
- **Dual Modes**: 
  - **Sir Mode**: Elevated access for the owner (you).
  - **Guest Protocol**: Polite, protective interface for others.

---

## 🚀 Getting Started

### 📋 Prerequisites

- **Node.js**: Version 18 or higher.
- **WhatsApp**: An active WhatsApp account on your phone.
- **API Keys**: You'll need at least one Groq API key:
  - [Groq API Key](https://console.groq.com/) (Required)

### 🛠️ Installation & Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/Anant3452/whatsappbot.git
   cd whatsappbot
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure Environment Variables:**
   Create a `.env` file in the root directory:
   ```env
   GROQ_API_KEY=your_key_here
   ```

4. **Set Your Identity (Crucial):**
   Open `index.js` and find the `SIR_NUMBER` constant (around line 48). Change it to your own WhatsApp ID:
   ```javascript
   const SIR_NUMBER = 'YOUR_PHONE_NUMBER@s.whatsapp.net';
   // Example: '919876543210@s.whatsapp.net'
   ```

---

## 🏃 Running the Bot

1. **Launch the assistant:**
   ```bash
   ./start.sh
   ```
2. **Authenticate**: A QR code will appear in your terminal. Scan it using **Linked Devices** in your WhatsApp mobile app.
3. **Go!**: Once the terminal says `[ J.A.R.V.I.S. ONLINE ]`, you're live!

---

## 🎮 Commands (Sir Only)

- `!s`: Show status (Model, History, Blocklist).
- `!p`: Pause guest replies.
- `!r`: Resume guest replies.
- `!clear`: Summarize and clear current chat history.
- `!block [number]`: Blacklist a user.
- `!help`: Show this menu.

---

## 🔒 Security Note
This assistant includes a `run_command` tool which allows it to execute shell commands. This is **restricted to Sir only**. Always ensure your `.env` and `auth_info_baileys` folder are kept private (they are excluded via `.gitignore` by default).

## 🛠️ Built With
- [Baileys](https://github.com/WhiskeySockets/Baileys) - WhatsApp Web API
- [Groq SDK](https://github.com/groq/groq-node) - LLM + Whisper transcription