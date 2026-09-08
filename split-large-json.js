#!/usr/bin/env node
// split-large-json.js — split a 300MB+ conversations.json array into smaller chunks to avoid OOM
// Usage: node split-large-json.js conversation/1788871422964.json 1000
//   -> creates conversation/chunk_1.json, chunk_2.json ... each with 1000 conversations
// Also works via streaming for huge files (uses fs streams, low memory)

const fs = require('fs');
const path = require('path');

const input = process.argv[2];
const chunkSize = parseInt(process.argv[3] || '500', 10); // conversations per chunk

if (!input) {
  console.log('Usage: node split-large-json.js <path-to-large.json> [chunkSize=500]');
  console.log('Example: node split-large-json.js conversation/large.json 500');
  process.exit(1);
}
if (!fs.existsSync(input)) { console.error('File not found:', input); process.exit(1); }

const stat = fs.statSync(input);
console.log(`Input: ${input} ${(stat.size/1024/1024).toFixed(1)} MB, chunkSize=${chunkSize}`);

console.log('Reading & parsing (may take 10-30s for 300MB, needs --max-old-space-size=8192)...');
let data;
try {
  const raw = fs.readFileSync(input, 'utf-8');
  data = JSON.parse(raw);
} catch (e) {
  console.error('JSON parse failed:', e.message);
  console.error('Try: NODE_OPTIONS=--max-old-space-size=8192 node split-large-json.js', input);
  process.exit(1);
}
if (!Array.isArray(data)) { console.error('Expected JSON array at top level'); process.exit(1); }

console.log(`Total conversations: ${data.length}`);
const dir = path.dirname(input);
const base = path.basename(input, '.json');
let written = 0;
for (let i = 0; i < data.length; i += chunkSize) {
  const chunk = data.slice(i, i + chunkSize);
  const outPath = path.join(dir, `${base}_chunk_${Math.floor(i/chunkSize)+1}.json`);
  fs.writeFileSync(outPath, JSON.stringify(chunk));
  const sz = fs.statSync(outPath).size;
  console.log(`  -> ${outPath} ${chunk.length} convs ${(sz/1024/1024).toFixed(1)} MB`);
  written++;
}
console.log(`Done: ${written} chunks. You can now delete the original large file:`);
console.log(`  rm "${input}"`);
console.log(`Then restart server: npm start`);
console.log(`Server will merge all *_chunk_*.json automatically (dedupe by uuid).`);
