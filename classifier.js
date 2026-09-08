// classifier.js — work vs personal prompt classifier
// Shared between Node (server.js) and browser (index.html via /classifier.js static)
// Keeps logic in one place so server augmentation and client filtering stay consistent.

const WORK_KEYWORDS = [
  // English work
  'meeting','report','project','client','customer','deadline','task','ticket','sprint','standup','retro',
  'kpi','okr','quarter','revenue','sales','marketing','finance','invoice','budget','forecast','audit',
  'deployment','deploy','server','api','database','sql','bug','fix','feature','code','pull request','pr','commit','review','merge','pipeline','jira','slack','email campaign','proposal','presentation','dashboard','analytics','sml',
  // Thai work
  'งาน','โปรเจค','โครงการ','ลูกค้า','รายงาน','ประชุม','ส่งงาน','เดดไลน์','บั๊ก','โค้ด','เซิร์ฟเวอร์','ใบเสนอราคา','งบประมาณ','ยอดขาย','การตลาด','บัญชี','ตรวจสอบ','นำเสนอ','ประชุมทีม','มอบหมายงาน','ตัวชี้วัด','okrs','ยอด','ดีล','สรุปการประชุม'
];

const PERSONAL_KEYWORDS = [
  // English personal
  'family','wife','husband','kid','child','baby','mom','dad','parent','girlfriend','boyfriend','relationship','love','dating','marriage','divorce',
  'vacation','holiday','trip','travel','hotel','flight','beach','hobby','football','soccer','movie','music','game','gaming','party','birthday','wedding','recipe','cooking','diet','gym','health','doctor','hospital','sick','joke','meme','astrology','horoscope','lottery','bet','crypto personal','shopping','clothes','fashion',
  'resume','cv','curriculum vitae','cover letter','biodata','portfolio personal',
  // Thai personal
  'ครอบครัว','แฟน','ภรรยา','สามี','ลูก','แม่','พ่อ','เพื่อน','เที่ยว','วันหยุด','พักผ่อน','งานแต่ง','วันเกิด','ปาร์ตี้','สูตรอาหาร','ทำอาหาร','สุขภาพ','หมอ','โรงพยาบาล','ดูดวง','หวย','ลอตเตอรี่','เกม','หนัง','เพลง','ฟุตบอล','ช้อปปิ้ง','เสื้อผ้า','แฟชั่น','ความรัก','เลิกกัน','อกหัก','กิ๊ก','เรซูเม','ประวัติส่วนตัว','สมัครงาน'
];

// Phrases that strongly tilt (weighted 2x)
const WORK_PHRASES = [
  'pull request','code review','client meeting','quarterly report','project deadline','action items','follow up with client','sml admin','sml portal'
];
const PERSONAL_PHRASES = [
  'my wife','my husband','my girlfriend','my boyfriend','my family','plan a trip','book a hotel','what to cook','how to cook',
  'help with my resume','update my cv','write my cover letter','improve my resume','ช่วยดูเรซูเม','ช่วยแก้ cv'
];

// Resume/CV file detection — any upload matching these filenames is forced to personal per policy
const RESUME_FILE_RE = /(resume|cv|curriculum[_ ]*vitae|cover[_ ]*letter|biodata|portfolio.*personal|เรซูเม|ประวัติส่วนตัว)/i;

function hasResumeFile(m) {
  const names = [];
  if (Array.isArray(m.files)) for (const f of m.files) if (f?.file_name) names.push(f.file_name);
  if (Array.isArray(m.attachments)) for (const a of m.attachments) {
    if (a?.file_name) names.push(a.file_name);
    if (a?.file_type) names.push(a.file_type);
    // extracted_content filename hint often in file_name
  }
  return names.some(n => RESUME_FILE_RE.test(n));
}
function getFileNames(m) {
  const names = [];
  if (Array.isArray(m.files)) for (const f of m.files) if (f?.file_name) names.push(f.file_name);
  if (Array.isArray(m.attachments)) for (const a of m.attachments) if (a?.file_name) names.push(a.file_name);
  return names;
}

function normalize(text) {
  if (!text) return '';
  return String(text).toLowerCase();
}

function countMatches(text, keywords) {
  let hits = [];
  const lower = normalize(text);
  for (const kw of keywords) {
    const re = new RegExp(`\\b${escapeRegExp(kw.toLowerCase())}\\b`, 'g');
    const m = lower.match(re);
    if (m) {
      hits.push({ keyword: kw, count: m.length });
    }
  }
  return hits;
}

function countPhraseMatches(text, phrases) {
  const lower = normalize(text);
  let count = 0;
  let hits = [];
  for (const ph of phrases) {
    if (lower.includes(ph.toLowerCase())) { count += 1; hits.push(ph); }
  }
  return { count, hits };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Allow Thai without word boundaries – Thai doesn't use spaces consistently for keywords.
// For Thai keywords use simple includes count.
function countThaiMatches(text, keywords) {
  const lower = normalize(text);
  let hits = [];
  for (const kw of keywords) {
    // only Thai-script keywords contain non-ascii
    if (!/[\u0E00-\u0E7F]/.test(kw)) continue;
    // count occurrences via split
    let count = lower.split(kw.toLowerCase()).length - 1;
    if (count > 0) hits.push({ keyword: kw, count });
  }
  return hits;
}

function classifyPrompt(rawText) {
  const text = normalize(rawText || '');
  if (!text.trim()) {
    return { label: 'unknown', confidence: 0, workScore: 0, personalScore: 0, reasons: ['empty'], hits: { work: [], personal: [] } };
  }
  if (text.length < 3) {
    return { label: 'unknown', confidence: 0, workScore: 0, personalScore: 0, reasons: ['too short'], hits: { work: [], personal: [] } };
  }

  // split counts: english word-boundary + thai includes
  const workHitsEn = countMatches(text, WORK_KEYWORDS.filter(k => !/[\u0E00-\u0E7F]/.test(k)));
  const personalHitsEn = countMatches(text, PERSONAL_KEYWORDS.filter(k => !/[\u0E00-\u0E7F]/.test(k)));
  const workHitsTh = countThaiMatches(text, WORK_KEYWORDS);
  const personalHitsTh = countThaiMatches(text, PERSONAL_KEYWORDS);

  const workPhrase = countPhraseMatches(text, WORK_PHRASES);
  const personalPhrase = countPhraseMatches(text, PERSONAL_PHRASES);

  const workScore = workHitsEn.reduce((s,h)=>s+h.count,0) + workHitsTh.reduce((s,h)=>s+h.count,0) + workPhrase.count * 2;
  const personalScore = personalHitsEn.reduce((s,h)=>s+h.count,0) + personalHitsTh.reduce((s,h)=>s+h.count,0) + personalPhrase.count * 2;

  const allWorkHits = [...workHitsEn, ...workHitsTh].map(h=>h.keyword).concat(workPhrase.hits);
  const allPersonalHits = [...personalHitsEn, ...personalHitsTh].map(h=>h.keyword).concat(personalPhrase.hits);

  let label = 'unknown';
  let confidence = 0;
  let reasons = [];

  if (workScore === 0 && personalScore === 0) {
    label = 'unknown';
    reasons.push('no keywords matched');
  } else if (workScore > 0 && personalScore === 0) {
    label = 'work';
    confidence = Math.min(0.95, 0.6 + workScore * 0.15);
    reasons.push(`work keywords: ${allWorkHits.slice(0,3).join(', ')}`);
  } else if (personalScore > 0 && workScore === 0) {
    label = 'personal';
    confidence = Math.min(0.95, 0.6 + personalScore * 0.15);
    reasons.push(`personal keywords: ${allPersonalHits.slice(0,3).join(', ')}`);
  } else {
    // both present
    const ratio = workScore / Math.max(1, personalScore);
    if (ratio >= 1.8) {
      label = 'work';
      confidence = 0.55 + Math.min(0.3, (ratio-1.8)*0.1);
      reasons.push(`work-heavy (${workScore} vs ${personalScore})`);
    } else if (ratio <= 0.56) { // 1/1.8
      label = 'personal';
      confidence = 0.55 + Math.min(0.3, (1/ratio -1.8)*0.1);
      reasons.push(`personal-heavy (${personalScore} vs ${workScore})`);
    } else {
      label = 'mixed';
      confidence = 0.5;
      reasons.push(`mixed keywords work:${allWorkHits.slice(0,2).join(',')} personal:${allPersonalHits.slice(0,2).join(',')}`);
    }
  }

  // Penalty for very short generic prompts classified with low hits -> downgrade to unknown
  if ((workScore + personalScore) === 1 && text.split(/\s+/).length < 6) {
    confidence = Math.min(confidence, 0.55);
  }

  return {
    label, // work | personal | mixed | unknown
    confidence: Math.round(confidence * 100) / 100,
    workScore,
    personalScore,
    reasons,
    hits: { work: allWorkHits, personal: allPersonalHits }
  };
}

// For server / client: classify a full message object (text + files) — resume/cv uploads are forced to personal
function classifyMessage(m) {
  if (m.sender !== 'human') return { label: 'assistant', confidence: 1, reasons: ['not a prompt'], workScore: 0, personalScore: 0, hits: { work: [], personal: [] } };
  if (hasResumeFile(m)) {
    const names = getFileNames(m);
    return {
      label: 'personal',
      confidence: 0.97,
      workScore: 0,
      personalScore: 5,
      reasons: [`resume/cv uploaded: ${names.slice(0,2).join(', ')}`],
      hits: { work: [], personal: ['resume/cv file'] }
    };
  }
  let txt = '';
  if (m.text) txt = m.text;
  else if (Array.isArray(m.content)) {
    txt = m.content.filter(c=>c.type==='text' && c.text).map(c=>c.text).join('\n');
  }
  // also feed file names into text for keyword scoring (e.g. "Alice_CV.pdf")
  const fileNames = getFileNames(m).join(' ');
  const combined = [txt, fileNames].filter(Boolean).join('\n');
  return classifyPrompt(combined);
}

// For server: augment a chat_messages array
function classifyMessages(messages) {
  return messages.map(m => {
    const c = classifyMessage(m);
    return { ...m, classification: c };
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { classifyPrompt, classifyMessages, classifyMessage, hasResumeFile, WORK_KEYWORDS, PERSONAL_KEYWORDS };
}
if (typeof window !== 'undefined') {
  window.classifyPrompt = classifyPrompt;
  window.classifyMessages = classifyMessages;
  window.classifyMessage = classifyMessage;
  window.hasResumeFile = hasResumeFile;
}
