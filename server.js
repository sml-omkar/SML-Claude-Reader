const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { classifyPrompt, classifyMessages, classifyMessage } = require('./classifier');
const { classifyMessageHybrid, classifyMessagesHybrid, healthCheck } = require('./llmClassifier');

const app = express();
const PORT = process.env.PORT || 5000;
const DATA_DIR = path.join(__dirname);
const USER_DIR = path.join(DATA_DIR, 'user');
const CONV_DIR = path.join(DATA_DIR, 'conversation');

[USER_DIR, CONV_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

function dedupeByUuid(arr) {
  const seen = new Set();
  return arr.filter(item => {
    if (!item.uuid || seen.has(item.uuid)) return false;
    seen.add(item.uuid);
    return true;
  });
}

function loadAllFromDir(dir, fallbackFile) {
  const results = [];
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const raw = fs.readFileSync(path.join(dir, file), 'utf-8');
      const data = JSON.parse(raw);
      if (Array.isArray(data)) results.push(...data);
    }
  } catch (e) { console.error('loadAllFromDir error:', e.message); }
  if (results.length) return dedupeByUuid(results);
  try {
    delete require.cache[require.resolve(fallbackFile)];
    const data = require(fallbackFile);
    if (Array.isArray(data)) return data;
  } catch (e) { console.error('loadAllFromDir fallback error:', e.message); }
  return null;
}

app.get('/api/users', (req, res) => {
  const data = loadAllFromDir(USER_DIR, './users.json');
  if (!data) return res.status(500).json({ error: 'Failed to load users' });
  res.json(data);
});

app.get('/api/conversations', (req, res) => {
  const data = loadAllFromDir(CONV_DIR, './conversations.json');
  if (!data) return res.status(500).json({ error: 'Failed to load conversations' });
  res.json(data);
});

app.get('/api/conversations/:userId', async (req, res) => {
  const users = loadAllFromDir(USER_DIR, './users.json');
  const conversations = loadAllFromDir(CONV_DIR, './conversations.json');
  if (!users || !conversations) {
    return res.status(500).json({ error: 'Failed to load data' });
  }
  const user = users.find(u => u.uuid === req.params.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  let userConversations = conversations.filter(c => c.account?.uuid === req.params.userId);
  // augment each message — use hybrid LLM if LLM_ENABLED else heuristic (fast)
  const useLLM = process.env.LLM_ENABLED === 'true';
  if (useLLM) {
    userConversations = await Promise.all(userConversations.map(async c => ({
      ...c,
      chat_messages: Array.isArray(c.chat_messages) ? await classifyMessagesHybrid(c.chat_messages) : c.chat_messages
    })));
  } else {
    userConversations = userConversations.map(c => ({
      ...c,
      chat_messages: Array.isArray(c.chat_messages) ? classifyMessages(c.chat_messages) : c.chat_messages
    }));
  }
  res.json({ user, conversations: userConversations });
});

// Classification engine API — uses local LLM if enabled, else heuristic
app.post('/api/classify', async (req, res) => {
  const { text, texts, fileName } = req.body || {};
  const useLLM = process.env.LLM_ENABLED === 'true';
  // single
  if (typeof text === 'string') {
    const fakeMsg = { sender: 'human', text, files: fileName ? [{ file_name: fileName }] : [] };
    const r = useLLM ? await classifyMessageHybrid(fakeMsg) : classifyMessage(fakeMsg);
    return res.json(r);
  }
  if (Array.isArray(texts)) {
    if (useLLM) {
      const out = await Promise.all(texts.map(t => classifyMessageHybrid({ sender: 'human', text: t })));
      return res.json(out);
    }
    return res.json(texts.map(t => classifyPrompt(t)));
  }
  // also support full message object
  if (req.body.sender) {
    const r = useLLM ? await classifyMessageHybrid(req.body) : classifyMessage(req.body);
    return res.json(r);
  }
  return res.status(400).json({ error: 'Provide {text: string} or {texts: string[]} or full message {sender, text, files}' });
});

app.get('/api/classify/health', async (req, res) => {
  const h = await healthCheck();
  // also report heuristic keyword count
  res.json({ ...h, fallback: 'heuristic ready', resumeRule: 'resume/cv files -> personal' });
});

app.get('/api/stats/classification', async (req, res) => {
  const users = loadAllFromDir(USER_DIR, './users.json');
  const conversations = loadAllFromDir(CONV_DIR, './conversations.json');
  if (!users || !conversations) return res.status(500).json({ error: 'Failed to load data' });
  const useLLM = process.env.LLM_ENABLED === 'true' && req.query.llm === 'true';
  const perUser = [];
  for (const u of users) {
    const ucs = conversations.filter(c => c.account?.uuid === u.uuid);
    let work = 0, personal = 0, mixed = 0, unknown = 0;
    for (const c of ucs) {
      for (const m of (c.chat_messages || [])) {
        if (m.sender !== 'human') continue;
        const r = useLLM ? await classifyMessageHybrid(m) : classifyMessage(m);
        if (r.label === 'work') work++;
        else if (r.label === 'personal') personal++;
        else if (r.label === 'mixed') mixed++;
        else unknown++;
      }
    }
    perUser.push({ uuid: u.uuid, full_name: u.full_name, email_address: u.email_address, work, personal, mixed, unknown, total: work+personal+mixed+unknown });
  }
  const totals = perUser.reduce((a,b)=>({ work:a.work+b.work, personal:a.personal+b.personal, mixed:a.mixed+b.mixed, unknown:a.unknown+b.unknown, total:a.total+b.total }), { work:0, personal:0, mixed:0, unknown:0, total:0 });
  res.json({ perUser, totals, engine: useLLM ? 'llm' : 'heuristic' });
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = file.fieldname === 'users' ? USER_DIR : CONV_DIR;
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const prefix = Date.now();
    const ext = path.extname(file.originalname) || '.json';
    cb(null, `${prefix}${ext}`);
  }
});

const upload = multer({ storage });

app.post('/api/upload/users', upload.fields([
  { name: 'users', maxCount: 1 },
  { name: 'conversations', maxCount: 1 }
]), (req, res) => {
  try {
    const uploaded = [];
    if (req.files?.users) uploaded.push('user/' + req.files.users[0].filename);
    if (req.files?.conversations) uploaded.push('conversation/' + req.files.conversations[0].filename);
    res.json({ success: true, files: uploaded });
  } catch (err) {
    res.status(500).json({ error: 'Upload failed' });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

app.listen(PORT, async () => {
  console.log(`Claude SML Admin running at http://localhost:${PORT}`);
  console.log(`Serving files from: ${__dirname}`);
  console.log(`Users dir: ${USER_DIR}`);
  console.log(`Conversations dir: ${CONV_DIR}`);
  const h = await healthCheck();
  console.log(`Classifier: ${h.enabled ? `LLM ${h.model} @ ${h.url} -> ${h.status}` : 'heuristic (set LLM_ENABLED=true for local LLM)'} | resume/cv -> personal`);
});
