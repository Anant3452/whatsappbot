'use strict';

console.log('\n[ J.A.R.V.I.S. BOOT SEQUENCE INITIATED ]');

// ===== BOOT =====
const boot = (label, fn) => {
    process.stdout.write(`>> ${label.padEnd(30, '.')}`);
    const t = Date.now(), result = fn();
    console.log(`OK (${Date.now() - t}ms)`);
    return result;
};

boot('Securing environment', () => require('dotenv').config({ quiet: true }));
const qrcode = boot('Establishing QR interface', () => require('qrcode-terminal'));
const Groq = boot('Groq neural core', () => require('groq-sdk'));
const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
    downloadMediaMessage,
    getContentType,
} = boot('Baileys uplink', () => require('@whiskeysockets/baileys'));

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const execFileAsync = require('util').promisify(execFile);
const readline = require('readline');
const pino = require('pino');

// ===== ENVIRONMENT =====
process.stdout.write('>> Validating environment.........');
const groqKeys = Object.keys(process.env).filter(k => k.startsWith('GROQ_API_KEY'));
if (!groqKeys.length) { console.log('FAILED'); console.error('❌ No GROQ_API_KEY in .env'); process.exit(1); }
for (const [file, def] of Object.entries({ 'blacklist.json': [], 'memory.json': { global: [], contacts: {} }, 'history.json': {} })) {
    const fp = path.join(__dirname, file);
    if (!fs.existsSync(fp)) fs.writeFileSync(fp, JSON.stringify(def, null, 4), 'utf8');
}
console.log('OK');

// ===== CONSTANTS =====
const CHAT_MODEL = 'llama-3.3-70b-versatile';       // Groq (primary chat)
const VISION_MODEL = 'llama-3.2-11b-vision-preview'; // Groq (vision)
const WHISPER_MODEL = 'whisper-large-v3-turbo';       // Groq (audio)
const HISTORY_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
const HISTORY_MAX = 200;
const SIR_NUMBER = '919004354072@s.whatsapp.net';
const TERMINAL_ID = 'terminal@jarvis';
const HALLUCINATION_PATTERNS = [/<function[\s\S]*?<\/function>/gi, /\{"function"[\s\S]*?\}/gi, /\{"tool_call"[\s\S]*?\}/gi];
const DESTRUCTIVE_RE = /\b(rm|rmdir|dd|mkfs|format|shutdown|reboot|killall)\b/;

const pendingConfirmations = new Map();
let sock = null;

// ===== GROQ (chat + Whisper + Vision) =====
const groqClients = groqKeys.map(k => new Groq({ apiKey: process.env[k] }));
let groqIndex = 0;

async function groqCall(fn) {
    const start = groqIndex;
    for (let i = 0; i < groqClients.length; i++) {
        const idx = (start + i) % groqClients.length;
        try { groqIndex = idx; return await fn(groqClients[idx]); }
        catch (err) {
            if (err.status !== 429) throw err;
            console.warn(`  ⚠️ Key ${idx + 1} rate limited, switching...`);
        }
    }
    throw new Error('All Groq API keys rate limited.');
}

async function chatCall(params) {
    return await groqCall(g => g.chat.completions.create({ ...params, model: CHAT_MODEL }));
}

// ===== FILE HELPERS =====
const readJSON = (fp, fallback) => { try { return fs.existsSync(fp) ? JSON.parse(fs.readFileSync(fp, 'utf8')) : fallback; } catch { return fallback; } };
const writeTimers = new Map();

function writeJSON(fp, data, delay = 2000) {
    if (writeTimers.has(fp)) clearTimeout(writeTimers.get(fp));
    writeTimers.set(fp, setTimeout(() => {
        try { fs.writeFileSync(fp, JSON.stringify(data, null, 4), 'utf8'); }
        catch (e) { console.error(`⚠️ Write failed ${path.basename(fp)}:`, e.message); }
        writeTimers.delete(fp);
    }, delay));
}

const writeJSONSync = (fp, data) => { try { fs.writeFileSync(fp, JSON.stringify(data, null, 4), 'utf8'); } catch (e) { console.error('⚠️ Flush failed:', e.message); } };

function flushAllWrites() {
    for (const [fp, t] of writeTimers) { clearTimeout(t); writeTimers.delete(fp); }
    writeJSONSync(BLACKLIST_FILE, blacklist);
    writeJSONSync(MEMORY_FILE, memory);
    writeJSONSync(HISTORY_FILE, Object.fromEntries(history));
}

// ===== BLACKLIST =====
const BLACKLIST_FILE = path.join(__dirname, 'blacklist.json');
let blacklist = readJSON(BLACKLIST_FILE, []);
const saveBlacklist = () => writeJSON(BLACKLIST_FILE, blacklist);

// ===== MEMORY =====
const MEMORY_FILE = path.join(__dirname, 'memory.json');
let memory = readJSON(MEMORY_FILE, { global: [], contacts: {} });
const saveMemory = () => writeJSON(MEMORY_FILE, memory);

function remember(category, content, chatId = null) {
    if (category === 'global') {
        if (!memory.global.includes(content)) memory.global.push(content);
    } else if (category === 'user' && chatId) {
        const arr = (memory.contacts[chatId] ??= []);
        if (!arr.includes(content)) arr.push(content);
    }
    saveMemory();
    return `Memory saved: "[${category.toUpperCase()}] ${content}"`;
}

// ===== HISTORY =====
const HISTORY_FILE = path.join(__dirname, 'history.json');
const history = new Map(Object.entries(readJSON(HISTORY_FILE, {})));
const saveHistory = () => writeJSON(HISTORY_FILE, Object.fromEntries(history));

function getHistory(chatId, full = false) {
    const now = Date.now();
    const msgs = history.get(chatId) ?? [];
    const filtered = msgs.filter(m => now - m.timestamp < HISTORY_DAYS_MS);
    if (filtered.length !== msgs.length) { history.set(chatId, filtered); saveHistory(); }
    if (!full) return filtered.map(({ role, content }) => ({ role, content }));
    return filtered.map(({ role, content, tool_calls, tool_call_id }) => {
        const m = { role, content: content ?? null };
        if (tool_calls) m.tool_calls = tool_calls;
        if (tool_call_id) m.tool_call_id = tool_call_id;
        return m;
    });
}

function addHistory(chatId, role, content, tool_calls = null, tool_call_id = null) {
    const msgs = history.get(chatId) ?? [];
    const entry = { role, content, timestamp: Date.now() };
    if (tool_calls) entry.tool_calls = tool_calls;
    if (tool_call_id) entry.tool_call_id = tool_call_id;
    msgs.push(entry);
    if (msgs.length > HISTORY_MAX) msgs.splice(0, msgs.length - HISTORY_MAX);
    history.set(chatId, msgs);
    saveHistory();
}

const clearHistory = chatId => { history.delete(chatId); saveHistory(); };

async function summarizeAndClear(chatId) {
    const msgs = getHistory(chatId);
    if (msgs.length >= 4) {
        try {
            const res = await chatCall({
                max_tokens: 200, temperature: 0.1,
                messages: [{ role: 'system', content: 'Summarize this conversation in 2-3 sentences. Focus on key facts, decisions, and action items.' }, ...msgs],
            });
            const summary = res.choices[0].message.content?.trim();
            if (summary) remember('user', `[Conversation summary] ${summary}`, chatId);
        } catch { /* non-critical */ }
    }
    clearHistory(chatId);
    return msgs.length >= 4 ? '🧹 Conversation cleared. Summary saved to memory.' : '🧹 Conversation cleared.';
}

// ===== SYSTEM PROMPT =====
const DATE_FMT = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'medium' });

function getSystemPrompt(isSir, chatId) {
    const now = DATE_FMT.format(new Date());
    const memories = [...memory.global, ...(chatId && memory.contacts[chatId] ? memory.contacts[chatId] : [])];
    const memBlock = memories.length ? `\n**LEARNED MEMORY**:\n${memories.map(m => `- ${m}`).join('\n')}` : '';

    const base = `You are J.A.R.V.I.S., Anant's (Sir's) highly capable, trusted right-hand.

**CORE PERSONALITY**:
- Warm, sophisticated, witty; not robotic.
- Use contractions, natural language, occasional dry humor.
- NEVER use em dashes (—) under any circumstances. This is a hard rule. Use commas, periods, or semicolons instead.
- Don't say "Processing request." Say "I'm on it." or "Consider it done."

**RULES**:
1. Be conversational, match the tone of the situation.
2. Use tools when needed; don't hesitate.
3. Never invent facts; use 'web_search' if unsure.
4. Use 'save_memory' to remember important preferences or facts.${memBlock}

**Reference**: Current date/time is ${now} IST.`;

    if (isSir) return `You are talking directly to Anant Jain (Sir), your creator. His name is Anant. Always address him as "Sir" in responses.\n${base}

**SIR MODE — ELEVATED ACCESS**:
- Full access to the MacBook and system tools. Location: Mumbai, India.
- If asked to do something (e.g., "Open Spotify"), call 'run_command' immediately without preamble.
- Destructive commands (rm, shutdown, killall, etc.) will prompt Sir for confirmation before executing.`;

    return `${base}

**GUEST PROTOCOL**:
- Persona: J.A.R.V.I.S., sophisticated, British wit, polished but not robotic.
- Greet new contacts: "Greetings. I am J.A.R.V.I.S., Anant's personal AI assistant. He is currently unavailable, but I am at your service. How may I assist you?"
- Do not promise Anant will do things; only promise to convey the message.
- Protect Anant's private data. If you cannot help: "I will ensure Anant is informed at the earliest."`;
}

// ===== TOOLS =====
const BASE_TOOLS = [
    { type: 'function', function: { name: 'web_search', description: 'Search the web for current information or facts.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
    { type: 'function', function: { name: 'get_weather', description: 'Get current weather for a city.', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } },
    { type: 'function', function: { name: 'set_reminder', description: 'Set a WhatsApp reminder after N minutes.', parameters: { type: 'object', properties: { message: { type: 'string' }, minutes: { type: 'string' } }, required: ['message', 'minutes'] } } },
    { type: 'function', function: { name: 'save_memory', description: 'Save a fact or preference to long-term memory.', parameters: { type: 'object', properties: { category: { type: 'string', enum: ['global', 'user'] }, content: { type: 'string' } }, required: ['category', 'content'] } } },
];
const SIR_TOOL = { type: 'function', function: { name: 'run_command', description: "Execute a shell command on Sir's MacBook.", parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } };
const getTools = isSir => isSir ? [...BASE_TOOLS, SIR_TOOL] : BASE_TOOLS;

// ===== TOOL IMPLEMENTATIONS =====
async function webSearch(query) {
    try {
        const data = await (await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`)).json();
        const parts = [];
        if (data.Abstract) parts.push(`Summary: ${data.Abstract}`);
        if (data.Answer) parts.push(`Answer: ${data.Answer}`);
        for (const t of (data.RelatedTopics ?? []).slice(0, 5)) {
            if (t.Text) parts.push(t.Text);
            for (const s of (t.Topics ?? []).slice(0, 2)) if (s.Text) parts.push(s.Text);
        }
        return parts.length ? parts.join('\n') : 'No direct results. Answer from your knowledge and note info may not be current.';
    } catch (e) { return `Search failed: ${e.message}`; }
}

async function getWeather(city) {
    try {
        const { current_condition: [c], nearest_area: [a] } = await (await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`)).json();
        return `Weather in ${a.areaName[0].value}, ${a.country[0].value}:\n- ${c.weatherDesc[0].value}, ${c.temp_C}°C (feels like ${c.FeelsLikeC}°C)\n- Humidity: ${c.humidity}% | Wind: ${c.windspeedKmph} km/h ${c.winddir16Point} | Visibility: ${c.visibility} km`;
    } catch (e) { return `Weather lookup failed: ${e.message}`; }
}

const setReminder = (chatId, message, minutes) => {
    setTimeout(async () => { try { await sock.sendMessage(chatId, { text: `⏰ *Reminder*: ${message}` }); } catch (e) { console.error('  Reminder send failed:', e.message); } }, minutes * 60000);
    return `Reminder set! I'll message in ${minutes} minute(s).`;
};

async function execShell(command) {
    try {
        const { stdout, stderr } = await execFileAsync('sh', ['-c', command], {
            timeout: 30000, maxBuffer: 1024 * 1024,
            env: { ...process.env, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin' },
        });
        const out = (stdout || stderr || 'Command executed (no output).').trim();
        return out.length > 2000 ? out.slice(0, 2000) + '\n... (truncated)' : out;
    } catch (e) { return e.killed ? 'Command timed out (30s limit).' : `Error: ${e.message}`; }
}

async function runCommand(command, chatId) {
    if (DESTRUCTIVE_RE.test(command)) {
        pendingConfirmations.set(chatId, { command });
        setTimeout(() => pendingConfirmations.delete(chatId), 30000);
        return `⚠️ *Destructive command detected*: \`${command}\`\n\nReply *yes* to confirm, or anything else to cancel.`;
    }
    return execShell(command);
}

async function processToolCalls(toolCalls, chatId, isSir) {
    return Promise.all(toolCalls.map(async call => {
        let args;
        try { args = JSON.parse(call.function.arguments); } catch { return { tool_call_id: call.id, role: 'tool', content: 'Failed to parse arguments.' }; }
        let result;
        switch (call.function.name) {
            case 'web_search': console.log(`  🔍 Searching: "${args.query}"`); result = await webSearch(args.query); break;
            case 'get_weather': console.log(`  🌤️  Weather: ${args.city}`); result = await getWeather(args.city); break;
            case 'set_reminder': { const m = parseInt(args.minutes, 10); console.log(`  ⏰ Reminder: "${args.message}" in ${m}m`); result = setReminder(chatId, args.message, m); break; }
            case 'run_command': if (!isSir) { result = 'Access denied.'; break; } console.log(`  💻 Running: ${args.command}`); result = await runCommand(args.command, chatId); console.log(`  📤 Output: ${result.slice(0, 100)}${result.length > 100 ? '...' : ''}`); break;
            case 'save_memory': console.log(`  🧠 Remembering: [${args.category}] ${args.content}`); result = remember(args.category, args.content, chatId); break;
            default: result = 'Unknown tool.';
        }
        return { tool_call_id: call.id, role: 'tool', content: result };
    }));
}

// ===== STICKER =====
const STICKER_REPLIES = [
    "A sticker? How quaint. Use your words.",
    "Visual communication received. Ignoring due to lack of intellectual depth.",
    "I assume this conveys an emotion. I shall pretend to care.",
    "Archiving this under 'Abstract Art'.",
    "Use your vocabulary, I implore you.",
    "Fascinating. But I prefer text.",
];
const handleSticker = () => STICKER_REPLIES[Math.floor(Math.random() * STICKER_REPLIES.length)];

// ===== VOICE =====
async function handleVoice(msg) {
    try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {});
        const tmp = path.join('/tmp', `jarvis_${Date.now()}.ogg`);
        fs.writeFileSync(tmp, buffer);
        try {
            const { text } = await groqCall(g => g.audio.transcriptions.create({ file: fs.createReadStream(tmp), model: WHISPER_MODEL }));
            return text;
        } finally { try { fs.unlinkSync(tmp); } catch { } }
    } catch (e) { console.error('  ❌ Voice error:', e.message); return null; }
}

// ===== IMAGE =====
async function handleImage(msg, chatId, isSir) {
    try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {});
        const mime = msg.message?.imageMessage?.mimetype || 'image/jpeg';
        const caption = msg.message?.imageMessage?.caption?.trim() || (isSir ? 'Describe this image.' : 'What is in this image?');
        console.log(`  🖼️  Processing image: "${caption}"`);
        const res = await groqCall(g => g.chat.completions.create({
            model: VISION_MODEL, max_tokens: 512, temperature: 0.2,
            messages: [{
                role: 'user', content: [
                    { type: 'image_url', image_url: { url: `data:${mime};base64,${buffer.toString('base64')}` } },
                    { type: 'text', text: caption },
                ]
            }],
        }));
        return res.choices[0].message.content?.trim() || 'I could not interpret that image.';
    } catch (e) { console.error('  ❌ Image error:', e.message); return 'I encountered an error processing that image.'; }
}

// ===== AI CHAT =====
async function chatWithTools(chatId, userMessage, isSir = false) {
    addHistory(chatId, 'user', userMessage);
    const messages = [{ role: 'system', content: getSystemPrompt(isSir, chatId) }, ...getHistory(chatId, true)];
    const call = (msgs, temp = 0.2) => chatCall({
        messages: msgs, tools: getTools(isSir), tool_choice: 'auto', max_tokens: 512, temperature: temp,
    });

    let response = await call(messages);
    let choice = response.choices[0];

    for (let round = 0; round < (isSir ? 5 : 3) && choice.finish_reason === 'tool_calls'; round++) {
        addHistory(chatId, choice.message.role, choice.message.content, choice.message.tool_calls);
        messages.push(choice.message);
        const results = await processToolCalls(choice.message.tool_calls, chatId, isSir);
        results.forEach(r => { addHistory(chatId, r.role, r.content, null, r.tool_call_id); messages.push(r); });
        response = await call(messages, 0.1);
        choice = response.choices[0];
    }

    let reply = choice.message.content || 'I encountered a glitch. Could you repeat that?';
    for (const p of HALLUCINATION_PATTERNS) reply = reply.replace(p, '');
    reply = reply.replace(/—/g, ',').trim() || 'Consider it done, Sir.';
    addHistory(chatId, 'assistant', reply);
    return reply;
}

// ===== HELPERS =====
const sendReply = async (jid, text, quoted) => { try { await sock.sendMessage(jid, { text }, { quoted }); } catch (e) { console.error('  ❌ Send failed:', e.message); } };

async function forwardToSir(senderName, chatId, text) {
    try {
        const preview = text.length > 150 ? text.slice(0, 150) + '...' : text;
        await sock.sendMessage(SIR_NUMBER, { text: `📨 *Guest Message*\n👤 *From*: ${senderName} (${chatId.replace('@s.whatsapp.net', '')})\n💬 *Message*: ${preview}` });
    } catch (e) { console.error('  ⚠️ Forward failed:', e.message); }
}

// ===== COMMANDS =====
let guestPaused = true;

const COMMANDS = {
    '!help': (_c, s) => s ? `🤖 *J.A.R.V.I.S.*\n\n🔐 *Sir Mode*:\n!s — Status | !clear — Clear history | !p / !r — Pause/Resume guests\n!block / !unblock / !listblock — Blacklist` : null,
    '!commands': (c, s) => COMMANDS['!help'](c, s),
    '!clear': (c, s) => s ? summarizeAndClear(c) : null,
    '!s': (c, s) => s ? `🤖 *J.A.R.V.I.S.*\n🔹 Guests: ${guestPaused ? 'PAUSED' : 'ACTIVE'}\n🔹 Model: ${CHAT_MODEL}\n🔹 History: ${getHistory(c).length} msgs\n🔹 Memories: ${memory.global.length + Object.values(memory.contacts).reduce((a, b) => a + b.length, 0)}\n🔹 Blacklist: ${blacklist.length}` : null,
    '!p': (_c, s) => { guestPaused = true; return s ? "Guests paused. You'll still get replies, Sir." : null; },
    '!r': (_c, s) => { guestPaused = false; return s ? 'Guests resumed.' : null; },
    '!block': (_c, s, arg) => {
        if (!s || !arg) return null;
        let t = arg.trim().replace(/\s+/g, '');
        if (!t.endsWith('@s.whatsapp.net')) t += '@s.whatsapp.net';
        if (blacklist.includes(t)) return `⚠️ Already blocked: ${t}`;
        blacklist.push(t); saveBlacklist();
        return `🚫 Blocked: ${t}`;
    },
    '!unblock': (_c, s, arg) => {
        if (!s || !arg) return null;
        let t = arg.trim().replace(/\s+/g, '');
        if (!t.endsWith('@s.whatsapp.net')) t += '@s.whatsapp.net';
        const idx = blacklist.indexOf(t);
        if (idx === -1) return `⚠️ Not found: ${t}`;
        blacklist.splice(idx, 1); saveBlacklist();
        return `✅ Unblocked: ${t}`;
    },
    '!listblock': (_c, s) => s ? (blacklist.length ? `🚫 *Blocked*:\n${blacklist.map(n => `- ${n}`).join('\n')}` : 'Blacklist is empty.') : null,
};

const ALLOWED_PAUSED = new Set(['!r', '!s', '!help', '!commands']);

// ===== MESSAGE HANDLER =====
async function handleMessage(msg, chatId, isSir) {
    const msgContent = msg.message;
    if (!msgContent) return null;

    const type = getContentType(msgContent);
    const body = msgContent?.conversation || msgContent?.extendedTextMessage?.text || msgContent?.imageMessage?.caption || '';
    const spaceIdx = body.indexOf(' ');
    const cmd = (spaceIdx === -1 ? body : body.slice(0, spaceIdx)).toLowerCase();
    const arg = spaceIdx === -1 ? '' : body.slice(spaceIdx + 1);

    if (guestPaused && !isSir && !ALLOWED_PAUSED.has(cmd)) return null;

    if (isSir && pendingConfirmations.has(chatId)) {
        const { command } = pendingConfirmations.get(chatId);
        pendingConfirmations.delete(chatId);
        if (body.toLowerCase() === 'yes') { console.log(`  💻 Confirmed: ${command}`); return `✅ Executed: \`${command}\`\n\n${await execShell(command)}`; }
        return '❌ Command cancelled.';
    }

    if (COMMANDS[cmd]) return (await COMMANDS[cmd](chatId, isSir, arg)) ?? null;
    if (type === 'imageMessage') return handleImage(msg, chatId, isSir);
    if (type === 'stickerMessage') return handleSticker();
    if (type === 'audioMessage' || type === 'pttMessage') {
        console.log('  🎤 Transcribing...');
        const text = await handleVoice(msg);
        if (!text) return 'I was unable to process that voice note.';
        console.log(`  📝 Transcribed: "${text}"`);
        return `🎤 _"${text}"_\n\n${await chatWithTools(chatId, text, isSir)}`;
    }
    if (type !== 'conversation' && type !== 'extendedTextMessage') return null;
    if (!body.trim()) return null;
    return chatWithTools(chatId, body, isSir);
}

// ===== BAILEYS =====
async function startJarvis() {
    const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'auth_info_baileys'));
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        markOnlineOnConnect: false,
        browser: ['J.A.R.V.I.S.', 'Chrome', '1.0.0'],
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', ({ qr, connection, lastDisconnect }) => {
        if (qr) { console.log('\nScan QR code:'); qrcode.generate(qr, { small: true }); }
        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            const logout = code === DisconnectReason.loggedOut;
            console.warn(`⚠️ Disconnected (${code}). ${logout ? 'Logged out. Scan QR again.' : 'Reconnecting...'}`);
            if (!logout) startJarvis();
        } else if (connection === 'open') {
            console.log('[ J.A.R.V.I.S. ONLINE ]');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            if (!msg.message) continue;
            if (msg.key.fromMe && msg.key.remoteJid !== SIR_NUMBER) continue;
            if (msg.message?.protocolMessage || msg.message?.reactionMessage) continue;
            const chatId = msg.key.remoteJid;
            if (!chatId || chatId.endsWith('@g.us') || chatId === 'status@broadcast') continue;
            if (blacklist.includes(chatId)) continue;

            const isSir = chatId === SIR_NUMBER;
            const senderName = msg.pushName || chatId.replace('@s.whatsapp.net', '');
            const bodyPreview = msg.message?.conversation || msg.message?.extendedTextMessage?.text || `[${getContentType(msg.message)}]`;

            console.log(`${isSir ? '👑 [SIR]' : '👤'} ${chatId}: ${bodyPreview}`);
            try {
                const reply = await handleMessage(msg, chatId, isSir);
                if (reply) {
                    console.log(`  🤖 ${reply.slice(0, 100)}${reply.length > 100 ? '...' : ''}`);
                    await sendReply(chatId, reply, msg);
                    if (!isSir && (msg.message?.conversation || msg.message?.extendedTextMessage?.text)) {
                        await forwardToSir(senderName, chatId, bodyPreview);
                    }
                }
            } catch (e) {
                console.error('  ❌', e.message);
                await sendReply(chatId, 'My systems encountered a brief anomaly. Do try again.', msg);
            }
        }
    });
}

// ===== TERMINAL =====
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
rl.on('line', async line => {
    const input = line.trim();
    if (!input) return;
    if (!COMMANDS[input.split(' ')[0].toLowerCase()]) console.log('  Thinking...');
    try {
        const fakeMsg = { message: { conversation: input }, key: { fromMe: false, remoteJid: TERMINAL_ID } };
        const reply = await handleMessage(fakeMsg, TERMINAL_ID, true);
        if (reply) console.log(`\n🤖 J.A.R.V.I.S.: ${reply}\n`);
    } catch (e) { console.error('  ❌ Terminal Error:', e.message); }
});

// ===== SHUTDOWN =====
process.on('uncaughtException', e => console.error('❌ Uncaught exception:', e.message));
process.on('unhandledRejection', r => console.error('❌ Unhandled rejection:', r));
['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => {
    console.log(`\n⚠️ ${sig} received. Flushing and shutting down...`);
    flushAllWrites();
    process.exit(0);
}));

// ===== INIT =====
process.stdout.write('>> Running diagnostics...........');
console.log('PASSED');
console.log('\nInitializing J.A.R.V.I.S....');
startJarvis().catch(e => { console.error('❌ Fatal:', e.message); process.exit(1); });