[Uploading README.md…]()
# Claude SML Admin

Admin portal to view employee Claude conversation logs. Upload `users.json` + `conversations.json` and browse per-employee history with work/personal classification.

Works on **Windows / macOS / Linux** — same steps on any device.

---

## Prerequisites (any device)

1. **Node.js v18+** — https://nodejs.org (LTS). Verify:
   ```bash
   node -v   # should show v18.x or v20.x
   npm -v
   ```
   - **Windows**: download `.msi` and run installer.
   - **macOS**: `brew install node` or installer.
   - **Linux (Ubuntu/Debian)**: `sudo apt update && sudo apt install nodejs npm`.

2. **Git** — https://git-scm.com (check `git --version`).

3. *(Optional, for AI classification)* **Ollama** — https://ollama.com — only if you want local LLM instead of keyword heuristic. See `Enable Local LLM` below. Needs ~2GB free RAM/disk for `qwen2.5:1.5b`.

---

## Setup on a New / Different Device (from scratch)

```bash
# 1. Clone (use your repo URL)
git clone https://github.com/your-org/claude-sml-admin.git
cd claude-sml-admin

# 2. Install dependencies (creates node_modules/)
npm install

# 3. Create env file (optional but recommended)
cp .env.example .env
# Edit .env if you need custom port or LLM:
# PORT=5000
# LLM_ENABLED=false   # true to enable local LLM
# LLM_URL=http://localhost:11434
# LLM_MODEL=qwen2.5:1.5b

# 4. Start server
npm start
# or: node server.js
# or dev mode: npm run dev  (auto-reload via nodemon)

# 5. Open in browser
# http://localhost:5000  (or http://<device-IP>:5000 from another machine on same network)
```

> **Port in use?** `PORT=5001 npm start` (Windows `set PORT=5001 && npm start`, macOS/Linux `PORT=5001 npm start`)

> **Firewall (Windows/macOS)**: allow Node.js when prompted, or open `5000` in firewall to access from LAN.

### Migrating data to the new device

- **Fresh start**: just upload via portal — `user/` and `conversation/` folders auto-create on first run `server.js:14`.
- **Copy existing data**: copy the `user/*.json` and `conversation/*.json` files from old device to the same folders on new device (all files merge deduped by `uuid` `server.js:22`). Or re-upload via `Upload Data`.
- **No upload yet?** Portal shows `Failed to load data. Upload files first.` — expected until first upload.

### Pull updates on the new device

```bash
git pull
npm install   # if package.json changed
npm start
```

---

## How to Use (after setup)

1. Open `http://localhost:5000`
2. Sidebar → **Upload Data** `index.html:166` → drag `users.json` (left) + `conversations.json` (right) → **Upload Files** `POST /api/upload/users` `server.js:128`
3. Sidebar → **Employees** → click name to view history (badges `work` blue / `personal` pink show per prompt)
4. **Prung** tab → work/personal/mixed counts + tokens `index.html:177`

Export files from Claude: `claude.ai` → Admin Panel (`claude.ai/admin`, needs Org Admin) → `Members → Export` + `Conversations/Compliance → Export`. If you only got `manifest.json` from `Data & Privacy → Export`, download the linked `users.json` + `conversations_*.json` next to it (manifest alone is just an index).

### How It Works

- All `*.json` in `user/` merged (`dedupeByUuid`) `server.js:31`
- All `*.json` in `conversation/` merged
- Each upload saves `user/<timestamp>.json` `server.js:120` — never overwrites old files

---

## Classification Engine

Every human prompt labeled `work` / `personal` / `mixed` / `unknown`:

- **Heuristic (default, offline)**: `classifier.js:5` EN+TH keywords + resume rule `classifier.js:32` (`resume|cv|cover letter|เรซูเม|ประวัติส่วนตัว` → forced `personal` `classifier.js:157`). Fast, tunable via `WORK_KEYWORDS`/`PERSONAL_KEYWORDS`.
- **Local LLM (optional)**: `llmClassifier.js:1` calls small LLM on your machine (Ollama / LM Studio). Falls back to heuristic if LLM down. Top bar shows `heuristic` vs `LLM: qwen2.5:1.5b` `index.html:362`, health at `GET /api/classify/health` `server.js:96`.

### Enable Local LLM

**Same device (LLM + portal on one machine):**
```bash
# 1. Install Ollama https://ollama.com
ollama pull qwen2.5:1.5b   # 1.5B ~1GB, CPU-friendly
# alternatives: llama3.2:3b / phi3:mini / gemma2:2b

# 2. Enable
cp .env.example .env
# set LLM_ENABLED=true, LLM_URL=http://localhost:11434, LLM_MODEL=qwen2.5:1.5b

# 3. Start (keep `ollama serve` running in another terminal)
npm start
curl http://localhost:5000/api/classify/health
curl -X POST http://localhost:5000/api/classify -H "Content-Type: application/json" -d '{"text":"update my CV"}'
```

**Different device (LLM on another machine / server):**
```bash
# On LLM machine: ollama serve --host 0.0.0.0  (exposes to LAN)
# On portal machine .env:
LLM_ENABLED=true
LLM_URL=http://<LLM-MACHINE-IP>:11434   # e.g. http://192.168.1.50:11434
LLM_MODEL=qwen2.5:1.5b
```
> For LM Studio: start Local Server at `http://localhost:1234`, set `LLM_URL=http://localhost:1234` (or remote IP).

---

## Project Structure

```
claude-sml-admin/
├── server.js           Express + APIs (/api/users, /api/conversations, /api/classify)
├── classifier.js       Heuristic work/personal + resume rule (shared Node+browser)
├── llmClassifier.js    Local LLM wrapper (Ollama / OpenAI-compatible) + fallback
├── index.html          Portal UI (Employees / Upload / Prung)
├── chat-portal.html    Legacy portal (unused)
├── .env.example        Env template (PORT, LLM_*)
├── user/               Uploaded users JSON (gitignored, auto-created)
├── conversation/       Uploaded conversations JSON (gitignored, auto-created)
└── package.json
```

## APIs

- `GET /api/users`, `GET /api/conversations`, `GET /api/conversations/:userId` (augmented with `classification`)
- `POST /api/classify` `{text}` or `{texts:[]}` or `{sender,text,files}` → `{label, confidence, reasons, engine}`
- `GET /api/classify/health` → `{enabled, url, model, status}`
- `GET /api/stats/classification` (add `?llm=true` to use LLM)
- `POST /api/upload/users` (multipart `users` + `conversations`)

## Troubleshooting (new device)

- `node: command not found` → reinstall Node.js and reopen terminal.
- `EADDRINUSE 5000` → `PORT=5001 npm start` or kill old `node server.js`.
- `Failed to load data` → upload JSON first or copy old `user/`/`conversation/` files.
- `LLM unreachable → heuristic` (top bar yellow) → check `ollama serve` running, `LLM_URL` correct, `curl <LLM_URL>/api/tags`.
- Access from another device on LAN → use `http://<PORTAL-MACHINE-IP>:5000` and allow firewall.
- `manifest.json` alone does nothing → download the actual `users.json` + `conversations.json` linked in manifest.

## Features

- Searchable employee list + per-user history with tool calls/thinking extracted
- Work/personal/mixed badges + filter + resume/CV auto-personal
- Prung analytics (totals, per-employee breakdown, tokens)
- Safe merging (deduped by `uuid`, timestamped uploads)
- Heuristic offline or local LLM (privacy: data stays on device)
