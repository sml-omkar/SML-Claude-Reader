// llmClassifier.js — local small LLM for work/personal classification
// Supports Ollama (http://localhost:11434) and any OpenAI-compatible endpoint (LM Studio, vLLM, llama.cpp)
// Falls back to classifier.js heuristic if LLM unavailable.
// Env: LLM_ENABLED=true LLM_URL=http://localhost:11434 LLM_MODEL=qwen2.5:1.5b LLM_TIMEOUT_MS=5000
// Tiny models that run on CPU/laptop: qwen2.5:1.5b, llama3.2:3b, phi3:mini, gemma2:2b — pick one via `ollama pull <model>`

const { classifyMessage: heuristicClassifyMessage, hasResumeFile } = require('./classifier');

const LLM_ENABLED = process.env.LLM_ENABLED === 'true';
const LLM_URL = (process.env.LLM_URL || 'http://localhost:11434').replace(/\/$/, '');
const LLM_MODEL = process.env.LLM_MODEL || 'qwen2.5:1.5b';
const LLM_TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS || '5000', 10);

// cache: text+filenames -> result
const cache = new Map();
const CACHE_MAX = 2000;

function cacheKey(m) {
  const txt = m.text || (Array.isArray(m.content) ? m.content.filter(c=>c.type==='text').map(c=>c.text).join('\n') : '');
  const files = [];
  if (Array.isArray(m.files)) for (const f of m.files) if (f?.file_name) files.push(f.file_name);
  if (Array.isArray(m.attachments)) for (const a of m.attachments) if (a?.file_name) files.push(a.file_name);
  return (txt + '||' + files.join('|')).slice(0, 2000);
}

function systemPrompt() {
  return `You are a strict classifier for an employee monitoring portal (SML company).
Classify the user prompt into exactly one label:
- "work": SML company work — reports, meetings, clients, projects, deadlines, KPI/OKR, code, bug fix, deployment, dashboard, invoice, presentation, work file upload
- "personal": non-work — family, kids, love/relationship, vacation/travel, hobby, game, health, birthday, recipe, shopping, meme, astrology, AND any resume/CV/cover letter/biodata upload (always personal even if text sounds work-like)
- "mixed": contains both work and personal intents equally
- "unknown": too short, empty, or no signal

Rules:
- If files include resume/cv/cover letter/เรซูเม -> always "personal".
- Thai prompts follow same rules (งาน=work, เที่ยว/ครอบครัว/เรซูเม=personal).
- Return ONLY JSON: {"label":"work|personal|mixed|unknown","confidence":0.0-1.0,"reason":"short reason"}`;
}

function userPrompt(m) {
  const txt = m.text || (Array.isArray(m.content) ? m.content.filter(c=>c.type==='text').map(c=>c.text).join('\n') : '');
  const files = [];
  if (Array.isArray(m.files)) for (const f of m.files) if (f?.file_name) files.push(f.file_name);
  if (Array.isArray(m.attachments)) for (const a of m.attachments) if (a?.file_name) files.push(a.file_name);
  let p = `Prompt text: """${(txt || '(no text)').slice(0, 2000)}"""`;
  if (files.length) p += `\nAttached files: ${files.join(', ')}`;
  p += `\nClassify now. JSON only.`;
  return p;
}

async function callOllama(promptSys, promptUser) {
  // Ollama /api/chat
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const res = await fetch(`${LLM_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: 'system', content: promptSys },
          { role: 'user', content: promptUser }
        ],
        stream: false,
        format: 'json',
        options: { temperature: 0, num_predict: 120 }
      }),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`Ollama ${res.status} ${await res.text()}`);
    const j = await res.json();
    const content = j.message?.content || j.response || '';
    return content;
  } finally { clearTimeout(t); }
}

async function callOpenAICompatible(promptSys, promptUser) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const res = await fetch(`${LLM_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: 'system', content: promptSys },
          { role: 'user', content: promptUser }
        ],
        temperature: 0,
        max_tokens: 120,
        response_format: { type: 'json_object' }
      }),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`OpenAI-compat ${res.status} ${await res.text()}`);
    const j = await res.json();
    return j.choices?.[0]?.message?.content || '';
  } finally { clearTimeout(t); }
}

function parseLLMJson(raw) {
  if (!raw) return null;
  // extract first { ... }
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    let label = String(j.label || '').toLowerCase().trim();
    if (!['work','personal','mixed','unknown'].includes(label)) return null;
    let conf = Number(j.confidence);
    if (isNaN(conf) || conf < 0 || conf > 1) conf = 0.7;
    return { label, confidence: Math.round(conf*100)/100, reason: String(j.reason || j.explanation || '').slice(0,120) };
  } catch { return null; }
}

async function classifyWithLLM(m) {
  if (!LLM_ENABLED) return null;
  // resume/cv short-circuit still via heuristic to save LLM call
  if (hasResumeFile(m)) {
    return { label: 'personal', confidence: 0.97, reason: 'resume/cv uploaded (pre-filter)', hits: { work: [], personal: ['resume/cv file'] }, workScore: 0, personalScore: 5, engine: 'heuristic+llm-skip' };
  }
  const key = cacheKey(m);
  if (cache.has(key)) return cache.get(key);

  const sys = systemPrompt();
  const usr = userPrompt(m);
  let raw = null;
  // try Ollama first, then OpenAI-compat
  try {
    raw = await callOllama(sys, usr);
  } catch (e) {
    // if Ollama 404, try OpenAI compat (LM Studio)
    try { raw = await callOpenAICompatible(sys, usr); } catch (e2) {
      // both failed -> fallback
      return null;
    }
  }
  const parsed = parseLLMJson(raw);
  if (!parsed) return null;
  const result = {
    label: parsed.label,
    confidence: parsed.confidence,
    workScore: parsed.label==='work'?1:0,
    personalScore: parsed.label==='personal'?1:0,
    reasons: [parsed.reason || 'llm'],
    hits: { work: parsed.label==='work'?['llm']: [], personal: parsed.label==='personal'?['llm']: [] },
    engine: 'llm',
    model: LLM_MODEL
  };
  if (cache.size > CACHE_MAX) cache.clear();
  cache.set(key, result);
  return result;
}

async function classifyMessageHybrid(m) {
  if (m.sender !== 'human') return { label: 'assistant', confidence: 1, reasons: ['not a prompt'], workScore:0, personalScore:0, hits:{work:[],personal:[]}, engine: 'none' };
  // try LLM first if enabled
  if (LLM_ENABLED) {
    try {
      const llm = await classifyWithLLM(m);
      if (llm) return llm;
    } catch (e) {
      console.warn('LLM classify failed, falling back to heuristic:', e.message);
    }
  }
  const h = heuristicClassifyMessage(m);
  return { ...h, engine: 'heuristic' };
}

async function classifyMessagesHybrid(messages) {
  // sequential to avoid overloading tiny LLM; batch 3 concurrent max
  const out = [];
  const concurrency = 3;
  let idx = 0;
  async function worker() {
    while (idx < messages.length) {
      const i = idx++;
      const m = messages[i];
      out[i] = { ...m, classification: await classifyMessageHybrid(m) };
    }
  }
  const workers = Array(Math.min(concurrency, messages.length)).fill(0).map(() => worker());
  await Promise.all(workers);
  return out;
}

async function healthCheck() {
  if (!LLM_ENABLED) return { enabled: false, status: 'disabled (set LLM_ENABLED=true to use local LLM)' };
  try {
    // try Ollama tags endpoint
    const controller = new AbortController();
    const t = setTimeout(()=>controller.abort(), 3000);
    const r = await fetch(`${LLM_URL}/api/tags`, { signal: controller.signal });
    clearTimeout(t);
    if (r.ok) {
      const j = await r.json();
      const models = (j.models||[]).map(x=>x.name);
      return { enabled: true, url: LLM_URL, model: LLM_MODEL, status: 'ollama ok', models, engine: 'ollama' };
    }
  } catch {}
  try {
    const controller = new AbortController();
    const t = setTimeout(()=>controller.abort(), 3000);
    const r = await fetch(`${LLM_URL}/v1/models`, { signal: controller.signal });
    clearTimeout(t);
    if (r.ok) return { enabled: true, url: LLM_URL, model: LLM_MODEL, status: 'openai-compat ok', engine: 'openai' };
  } catch {}
  return { enabled: true, url: LLM_URL, model: LLM_MODEL, status: 'unreachable', engine: 'unknown' };
}

module.exports = { classifyWithLLM, classifyMessageHybrid, classifyMessagesHybrid, healthCheck, LLM_ENABLED, LLM_URL, LLM_MODEL };
