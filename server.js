const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const compression = require('compression');
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

app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));

// Loading status for frontend polling (large 300MB file)
app.get('/api/loading-status', (req, res) => {
  res.json(loadingStatus);
});

// --- Caching for large files (300MB+) — parse once, serve many ---
const cache = {
  users: { data: null, key: '' },
  convs: { data: null, key: '' }
};
function dirKey(dir) {
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    // key = filenames + mtimes + sizes (cheap invalidation)
    return files.map(f => {
      const s = fs.statSync(path.join(dir, f));
      return `${f}:${s.mtimeMs}:${s.size}`;
    }).join('|');
  } catch { return ''; }
}
let loadingStatus = { loading: false, message: 'Idle', slot: '', start: 0 };
function setLoading(slot, msg) {
  loadingStatus = { loading: true, message: msg, slot, start: Date.now() };
  console.log(`[${new Date().toISOString()}] ${msg}`);
}
function clearLoading(slot, detail) {
  const ms = Date.now() - loadingStatus.start;
  console.log(`[${new Date().toISOString()}] Done ${slot} in ${ms}ms ${detail||''}`);
  loadingStatus = { loading: false, message: 'Ready', slot: '', start: 0 };
}
function loadAllFromDirCached(dir, fallbackFile, cacheSlot) {
  const key = dirKey(dir);
  if (cache[cacheSlot].key === key && cache[cacheSlot].data) return cache[cacheSlot].data;
  // miss -> load with logs
  const t0 = Date.now();
  setLoading(cacheSlot, `Parsing ${cacheSlot} (${dir}) — ${fs.readdirSync(dir).filter(f=>f.endsWith('.json')).length} file(s)...`);
  const results = [];
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const fp = path.join(dir, file);
      const size = fs.statSync(fp).size;
      if (size > 20*1024*1024) console.log(`  -> ${file} ${(size/1024/1024).toFixed(1)}MB parsing...`);
      const t1 = Date.now();
      const raw = fs.readFileSync(fp, 'utf-8');
      const data = JSON.parse(raw);
      const ms = Date.now()-t1;
      console.log(`  -> ${file}: ${Array.isArray(data)?data.length:1} records parsed in ${ms}ms`);
      if (Array.isArray(data)) results.push(...data);
      else if (data && typeof data === 'object') results.push(data);
    }
  } catch (e) { console.error('loadAllFromDir error:', e.message, e.stack?.slice(0,300)); }
  let out = null;
  if (results.length) out = dedupeByUuid(results);
  else {
    try {
      delete require.cache[require.resolve(fallbackFile)];
      const data = require(fallbackFile);
      if (Array.isArray(data)) out = data;
    } catch (e) { /* no fallback */ }
  }
  if (out) {
    cache[cacheSlot].key = key;
    cache[cacheSlot].data = out;
    clearLoading(cacheSlot, `-> ${out.length} records total in ${Date.now()-t0}ms`);
  } else {
    clearLoading(cacheSlot, `-> no data (${Date.now()-t0}ms)`);
  }
  return out;
}
function invalidateCache() { cache.users.key=''; cache.convs.key=''; console.log('[cache] invalidated'); }

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
  const data = loadAllFromDirCached(USER_DIR, './users.json', 'users');
  if (!data) return res.json([]);
  res.json(data);
});

// Lightweight overview — no 300MB download on page load
app.get('/api/stats/overview', (req, res) => {
  const users = loadAllFromDirCached(USER_DIR, './users.json', 'users') || [];
  const conversations = loadAllFromDirCached(CONV_DIR, './conversations.json', 'convs') || [];
  if (!users.length && !conversations.length) return res.json({ users: 0, conversations: 0, messages: 0, perUser: [] });
  const perUser = users.map(u => {
    const ucs = conversations.filter(c => c.account?.uuid === u.uuid);
    const msgs = ucs.reduce((s,c)=>s+(c.chat_messages?c.chat_messages.length:0),0);
    const last = ucs.map(c=>new Date(c.updated_at)).filter(d=>!isNaN(d)).sort((a,b)=>b-a)[0] || null;
    return { uuid: u.uuid, full_name: u.full_name, email_address: u.email_address, conversations: ucs.length, messages: msgs, last_active: last ? last.toISOString() : null };
  });
  res.json({ users: users.length, conversations: conversations.length, messages: conversations.reduce((s,c)=>s+(c.chat_messages?c.chat_messages.length:0),0), perUser });
});

app.get('/api/conversations', (req, res) => {
  const data = loadAllFromDirCached(CONV_DIR, './conversations.json', 'convs') || [];
  // support pagination / lightweight query to avoid 300MB transfer
  const { userId, limit, offset, summary } = req.query;
  let filtered = data;
  if (userId) filtered = filtered.filter(c => c.account?.uuid === userId);
  const total = filtered.length;
  if (summary === 'true') {
    // strip chat_messages to just count
    filtered = filtered.map(c => ({ uuid: c.uuid, account: c.account, created_at: c.created_at, updated_at: c.updated_at, message_count: c.chat_messages?c.chat_messages.length:0 }));
  }
  if (limit) {
    const l = Math.min(parseInt(limit,10)||20, 100);
    const o = parseInt(offset,10)||0;
    filtered = filtered.slice(o, o+l);
    res.set('X-Total-Count', String(total));
  } else if (total > 500) {
    // safety: don't blast 300MB by default if client forgot pagination
    console.warn(`Large /api/conversations request: ${total} convs, no limit — sending only first 100 + header`);
    res.set('X-Total-Count', String(total));
    res.set('X-Warning', 'Truncated to 100, use ?limit=&offset= or /api/conversations/:userId?page=&limit=');
    filtered = filtered.slice(0, 100);
  }
  res.json(filtered);
});

app.get('/api/conversations/:userId', async (req, res) => {
  const users = loadAllFromDirCached(USER_DIR, './users.json', 'users') || [];
  const conversations = loadAllFromDirCached(CONV_DIR, './conversations.json', 'convs') || [];
  if (!users.length) {
    return res.status(500).json({ error: 'No users loaded' });
  }
  const user = users.find(u => u.uuid === req.params.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  let userConversations = conversations.filter(c => c.account?.uuid === req.params.userId);
  // sort newest first
  userConversations.sort((a,b)=> new Date(b.updated_at) - new Date(a.updated_at));
  // pagination
  const page = Math.max(1, parseInt(req.query.page,10)||1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit,10)||10));
  const filter = req.query.filter; // work/personal/mixed/unknown
  const search = (req.query.search||'').toLowerCase();
  // optional pre-filter by classification/search before pagination (needs classification)
  // For large data we classify only the page slice to keep it fast; but filter needs all. So handle:
  let total = userConversations.length;
  let filtered = userConversations;
  const needClassifyForFilter = filter && ['work','personal','mixed','unknown'].includes(filter);
  if (needClassifyForFilter || search) {
    // classify all for this user (still bounded to one user, not 300MB all users)
    const useLLM = process.env.LLM_ENABLED === 'true';
    // for stats page we keep heuristic for speed; LLM would be too slow for 300MB scan
    // use heuristic for filtering even if LLM enabled (fast)
    filtered = userConversations.filter(c => {
      const msgs = c.chat_messages || [];
      // check if any message matches filter/search
      return msgs.some(m => {
        if (m.sender !== 'human') return false;
        if (search) {
          const txt = (m.text || (Array.isArray(m.content)?m.content.filter(x=>x.type==='text').map(x=>x.text).join(' ') : '')).toLowerCase();
          if (!txt.includes(search)) return false;
        }
        if (needClassifyForFilter) {
          const cls = classifyMessage(m); // heuristic fast
          return cls.label === filter;
        }
        return true;
      });
    });
    total = filtered.length;
  }
  const start = (page-1)*limit;
  let pageSlice = filtered.slice(start, start+limit);
  // augment only the page slice with classification
  const useLLM = process.env.LLM_ENABLED === 'true' && req.query.llm === 'true';
  if (useLLM) {
    pageSlice = await Promise.all(pageSlice.map(async c => ({
      ...c,
      chat_messages: Array.isArray(c.chat_messages) ? await classifyMessagesHybrid(c.chat_messages) : c.chat_messages
    })));
  } else {
    pageSlice = pageSlice.map(c => ({
      ...c,
      chat_messages: Array.isArray(c.chat_messages) ? classifyMessages(c.chat_messages) : c.chat_messages
    }));
  }
  res.set('X-Total-Count', String(total));
  res.set('X-Page', String(page));
  res.set('X-Limit', String(limit));
  res.json({ user, conversations: pageSlice, total, page, limit, hasMore: start+limit < total });
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
  const users = loadAllFromDirCached(USER_DIR, './users.json', 'users') || [];
  const conversations = loadAllFromDirCached(CONV_DIR, './conversations.json', 'convs') || [];
  if (!users.length) return res.json({ perUser: [], totals: { work:0, personal:0, mixed:0, unknown:0, total:0 }, engine: 'heuristic' });
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

app.post('/api/upload/users', (req, res, next) => {
  console.log(`[upload] receiving ${req.headers['content-length'] ? (req.headers['content-length']/1024/1024).toFixed(1)+'MB' : ''}...`);
  next();
}, upload.fields([
  { name: 'users', maxCount: 1 },
  { name: 'conversations', maxCount: 1 }
]), (req, res) => {
  try {
    const uploaded = [];
    if (req.files?.users) { console.log(`[upload] users -> ${req.files.users[0].filename} ${(req.files.users[0].size/1024/1024).toFixed(1)}MB`); uploaded.push('user/' + req.files.users[0].filename); }
    if (req.files?.conversations) { console.log(`[upload] conversations -> ${req.files.conversations[0].filename} ${(req.files.conversations[0].size/1024/1024).toFixed(1)}MB`); uploaded.push('conversation/' + req.files.conversations[0].filename); }
    console.log(`[upload] done, invalidating cache (next request will re-parse, may take ~15s for 300MB)`);
    invalidateCache();
    res.json({ success: true, files: uploaded });
  } catch (err) {
    console.error('[upload] failed', err.message);
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
