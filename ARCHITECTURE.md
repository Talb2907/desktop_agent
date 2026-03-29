# Personal Desktop Agent — Architecture

---

## 1. What This Project Is

A Windows desktop application that wraps an AI agent in an Electron window. The user types a free-text request in Hebrew or English, and the agent autonomously decides which tools to use — searching files, browsing the web, controlling a browser, reading Gmail, accessing Outlook, or storing memories — then returns a synthesized answer.

The architecture follows an **Orchestrator → Specialist Agent** pattern: a top-level Claude instance routes each request to one or more specialist sub-agents, each of which runs its own inner reasoning loop with a focused set of tools.

---

## 2. Tech Stack

| Technology | Role | Why it was chosen |
|---|---|---|
| **Electron** | Desktop shell | Runs on Windows without a server; provides native OS access (file system, OS paths) via Node.js while hosting a React UI |
| **React + Vite** | Renderer UI | Fast HMR in dev, small bundle in prod; component model handles streaming step updates cleanly |
| **Tailwind CSS** | Styling | Utility-first, no build-time CSS overhead, easy RTL support |
| **Claude API (`claude-sonnet-4-5`)** | AI reasoning | Native tool-use support; streaming; handles Hebrew naturally |
| **`@anthropic-ai/sdk`** | API client | Official SDK with typed tool-use helpers |
| **Playwright** | Browser automation | Headful Chrome with persistent profiles; far more reliable than Puppeteer for real-site automation |
| **better-sqlite3** | Persistence | Synchronous, zero-config, embeds directly in Electron; WAL mode for performance |
| **`@xenova/transformers`** | Local embeddings | Runs `all-MiniLM-L6-v2` (384-dim) in-process; no external embedding API needed; supports Hebrew + English |
| **docx / exceljs / pptxgenjs / puppeteer** | Office file creation | Purpose-built libraries for each Office format; Puppeteer used only for PDF rendering |
| **dotenv** | Secrets | Keeps API key out of source code |
| **PowerShell** | Windows OS APIs | Accesses Outlook COM object and resolves OneDrive-backed Desktop paths that `os.homedir()` gets wrong |

---

## 3. Project Structure

```
desktop_agent/
├── main.js                          # Electron main process — creates window, handles IPC
├── preload.js                       # contextBridge — exposes 3 safe methods to renderer
├── index.html                       # HTML shell for Vite/React
├── vite.config.js                   # Vite: port 3500, React plugin, outDir=dist
├── tailwind.config.js               # Tailwind content paths
├── postcss.config.js                # PostCSS + autoprefixer
├── package.json                     # All dependencies + electron-rebuild postinstall
├── .env                             # ANTHROPIC_API_KEY (git-ignored)
├── .gitignore                       # Ignores node_modules, .env, *.db, dist/, etc.
├── README.md                        # Quick-start guide
├── CLAUDE.md.txt                    # Original architecture notes (pre-multi-agent)
│
└── src/
    ├── renderer/
    │   ├── main.jsx                 # React entry — mounts <App /> into #root
    │   ├── App.jsx                  # Entire chat UI (~460 lines)
    │   └── index.css                # Tailwind imports + RTL + scrollbar styles
    │
    └── agent/
        ├── agent.js                 # Public entry point — thin wrapper over orchestrator
        ├── orchestrator.js          # Orchestrator reasoning loop (routes to specialist agents)
        ├── prompts.js               # Orchestrator system prompt + memory injection
        ├── tools.js                 # ALL tool definitions (JSON schema) + ALL implementations
        ├── db.js                    # SQLite schema, CRUD helpers (conversations + memories)
        ├── embeddings.js            # Lazy-loaded embedder, cosine similarity, searchSimilar()
        ├── browserSession.js        # Singleton Playwright browser (anonymous, headed)
        ├── confirm.js               # Shared confirmation gate (promise-based)
        │
        └── agents/
            ├── base.js              # runSpecialist() — generic specialist reasoning loop
            ├── fileAgent.js         # FileAgent — file/folder CRUD, Office file creation
            ├── webAgent.js          # WebAgent — fetch_webpage only
            ├── memoryAgent.js       # MemoryAgent — save/search SQLite memories
            ├── outlookAgent.js      # OutlookAgent — Outlook email + calendar via PowerShell
            ├── browserAgent.js      # BrowserAgent — full Playwright automation
            ├── gmailAgent.js        # GmailAgent — Gmail via persistent Chrome profile
            └── gmailSession.js      # Singleton persistent Chrome context for Gmail
```

---

## 4. Agent Reasoning Loop — Step by Step

### 4a. Message Flow (top level)

```
User types message
      │
      ▼ (IPC: agent:run)
  main.js  ──► runAgent()  ──► runOrchestrator()
      │                              │
      │                    1. embed user message
      │                    2. searchSimilar() over conversation DB
      │                    3. build system prompt (inject relevant memories)
      │                    4. call Claude API with orchestrator tools
      │                              │
      │               ┌─────────────┴──────────────┐
      │         Claude picks                 Claude answers
      │         a specialist agent           directly (no tool)
      │               │                            │
      │         execute agent               return final text
      │         get text result                    │
      │               │                            │
      │         feed result back ◄─────────────────┘
      │         to Claude (max 6 rounds)
      │               │
      │         save conversation to SQLite
      │               │
      ▼ (return)
  main.js sends final text + all steps to renderer
      │
      ▼ (IPC: agent:step events)
  App.jsx renders each step in real time
```

### 4b. Specialist Agent Loop (inside each agent)

Each specialist runs `runSpecialist()` from `base.js`:

```
task string arrives from orchestrator
      │
      ▼
Call Claude API with agent's system prompt + agent's tool subset
      │
      ├── Claude returns tool_use block
      │         │
      │   Is tool write/destructive?
      │    YES ──► emit confirm_required step ──► waitForConfirmation()
      │              user clicks Approve/Deny in UI
      │              ──► IPC agent:confirm ──► resolveConfirmation()
      │    NO  ──► execute immediately
      │         │
      │   executeTool(name, input)  ──► returns result
      │   If tool returns screenshot ──► add as multimodal image block
      │   Append tool_result to messages
      │   Loop (max 8 rounds)
      │
      └── Claude returns text block
              │
              ▼
          Return text to orchestrator
```

### 4c. Confirmation Gate

`confirm.js` holds a single `_resolve` slot. When a write tool is about to execute:
1. `base.js` emits a `confirm_required` step (carries tool name + params).
2. `App.jsx` renders a confirmation dialog.
3. User clicks Approve → `window.agent.confirm(true)` → IPC → `resolveConfirmation(true)`.
4. The `await waitForConfirmation()` promise resolves; tool executes (or is skipped).

Only one confirmation can be pending at a time (single-slot design).

---

## 5. All Current Tools

### File Tools (FileAgent)

| Tool | Input | Output | Implementation |
|---|---|---|---|
| `search_files` | `query`, `path?`, `search_content?` | List of matching paths + metadata | PowerShell `Get-ChildItem` recursive |
| `read_file` | `filepath` | File text (first 5000 chars) | Node.js `fs.readFileSync` |
| `read_excel` | `filepath`, `sheet?` | Tab-separated cell data | `exceljs` |
| `create_file` | `filepath`, `content`, `overwrite?` | Success/exists status | `fs.writeFileSync` with path blocking |
| `append_to_file` | `filepath`, `content` | Success/error | `fs.appendFileSync` |
| `delete_file` | `filepath` | Success/error | PowerShell `Shell.Application` → Recycle Bin |
| `open_file_or_folder` | `filepath` | Confirmation | PowerShell `Invoke-Item` |
| `create_word_file` | `filepath`, `content` | Success/path | `docx` library |
| `create_excel_file` | `filepath`, `content` (TSV rows) | Success/path | `exceljs` |
| `create_pdf_file` | `filepath`, `content` (text/HTML) | Success/path | Puppeteer headless render |
| `create_powerpoint_file` | `filepath`, `slides` (blank-line separated) | Success/path | `pptxgenjs` |

### Web Tools (WebAgent)

| Tool | Input | Output | Implementation |
|---|---|---|---|
| `fetch_webpage` | `url` | Title + text content (3000 chars) | `node-fetch` + HTML tag stripping |

### Browser Tools (BrowserAgent)

All tools use the singleton browser from `browserSession.js` (anonymous Playwright Chromium, headed).

| Tool | Input | Output | Implementation |
|---|---|---|---|
| `browser_open` | `url` | Screenshot (base64) | `page.goto()` + screenshot |
| `browser_click` | `selector`, `description?` | Screenshot after click | `page.click()` + screenshot |
| `browser_type` | `selector`, `text`, `clear_first?` | Confirmation | `page.fill()` or `page.type()` |
| `browser_scroll` | `direction`, `amount?` | Confirmation | `page.evaluate(window.scrollBy)` |
| `browser_screenshot` | _(none)_ | Screenshot (base64) | `page.screenshot()` |
| `browser_extract` | `selector?` | Page text | `page.textContent()` or `page.innerText()` |
| `browser_close` | _(none)_ | Confirmation | `closeBrowser()` |

### Gmail Tools (GmailAgent)

All tools use the singleton persistent Chrome context from `gmailSession.js` (real Chrome with user's logged-in profile).

| Tool | Input | Output | Implementation |
|---|---|---|---|
| `gmail_open_inbox` | _(none)_ | Screenshot | Navigate to `mail.google.com` |
| `gmail_read_emails` | `max_results?`, `unread_only?` | JSON list of emails | DOM scraping via Playwright |
| `gmail_read_email` | `subject_or_index` | Full email content | Click email, extract body |
| `gmail_search` | `query` | JSON list of results | Navigate to Gmail search URL |
| `gmail_compose` | `to`, `subject`, `body` | Screenshot of compose window | Click Compose, fill fields |
| `gmail_send` | `to`, `subject`, `body_preview` | Confirmation | Click Send button (**always requires user confirmation**) |
| `gmail_create_draft` | `to`, `subject`, `body_preview` | Confirmation | Close compose window (saves draft) |

### Memory Tools (MemoryAgent)

| Tool | Input | Output | Implementation |
|---|---|---|---|
| `save_memory` | `content` | Confirmation with ID | `embed()` + `saveMemory()` to SQLite |
| `search_memory` | `query`, `top_k?` | List of relevant memories + conversations | `searchSimilar()` over all DB embeddings |
| `get_recent_conversations` | `limit?` | Last N conversations | `getRecentConversations()` from SQLite |

### Outlook Tools (OutlookAgent)

| Tool | Input | Output | Implementation |
|---|---|---|---|
| `search_emails` | `query`, `date_filter?` | List of emails (subject/sender/date/preview) | PowerShell + Outlook COM object |
| `read_calendar` | `days_ahead?` | List of calendar events | PowerShell + Outlook calendar API |

---

## 6. What Is Built vs. What Is Planned

### Built (Phase 1–4)

- [x] Electron desktop app with React UI
- [x] Orchestrator → Specialist Agent routing
- [x] FileAgent — full CRUD + 4 Office file formats (Word, Excel, PDF, PowerPoint)
- [x] WebAgent — URL fetch + text extraction
- [x] BrowserAgent — full Playwright automation (open, click, type, scroll, screenshot, extract)
- [x] GmailAgent — read inbox, search, compose, send, create draft
- [x] MemoryAgent — semantic search with local embeddings
- [x] OutlookAgent — email search + calendar read
- [x] Confirmation dialogs for all write/destructive actions
- [x] Real-time step streaming to UI
- [x] Hebrew + English with RTL layout
- [x] SQLite persistence for conversations and memories
- [x] Local embeddings via `@xenova/transformers` (no external API)
- [x] Semantic memory injection into orchestrator context

### Planned / Not Yet Built

- [ ] Write actions for Outlook (send email, create calendar event)
- [ ] Multi-step task planning (break a complex request into sub-tasks)
- [ ] Agent-to-agent delegation (agents calling other agents)
- [ ] User-configurable settings UI (model, paths, preferences)
- [ ] Background task scheduling / cron-like automation
- [ ] Notification system for long-running tasks
- [ ] Electron packaging / installer (currently dev-only with `npm start`)
- [ ] Cross-platform support (currently Windows-only due to PowerShell + Outlook COM)

---

## 7. Known Limitations

| Limitation | Detail |
|---|---|
| **Windows-only** | PowerShell is used for file search, Outlook COM, and resolving the real Desktop path. None of this works on macOS/Linux. |
| **Outlook must be open** | The `search_emails` and `read_calendar` tools use COM automation — Outlook must be installed and running. |
| **Gmail requires logged-in Chrome** | `gmailSession.js` hardcodes the path `C:\Users\Talb2\AppData\Local\Google\Chrome\User Data\Default`. This path must exist and be logged into Gmail. Not portable to other machines without editing. |
| **Single confirmation slot** | Only one write action can be pending at a time. Parallel write operations from two tabs would race. |
| **PDF generation uses Puppeteer** | `create_pdf_file` launches a headless Chromium, which is slow and adds ~200 MB to node_modules. |
| **Embedding model download on first use** | `all-MiniLM-L6-v2` (~22 MB) is downloaded from HuggingFace Hub on first run. Requires internet on first launch. |
| **No authentication/multi-user** | The app runs as the local user; there is no login or permission boundary. |
| **Max tool rounds** | Orchestrator: 6 rounds. Specialist agents: 8 rounds. Complex multi-step tasks may hit the ceiling. |
| **File read limit** | `read_file` returns only the first 5000 characters. Large files are silently truncated. |
| **No tests** | There are no automated tests — the codebase relies on manual QA. |

---

## 8. How to Add a New Tool

Follow these 4 steps. Use `fetch_webpage` as a minimal reference example.

### Step 1 — Implement the function in `tools.js`

Add your function at the bottom of `src/agent/tools.js`:

```js
async function myNewTool({ param1, param2 }) {
  // Do the actual work here
  const result = doSomething(param1, param2);
  return { success: true, result };
}
```

### Step 2 — Add the JSON schema to `TOOL_DEFINITIONS` in `tools.js`

Find the `TOOL_DEFINITIONS` array and add your entry:

```js
{
  name: 'my_new_tool',
  description: 'One sentence describing what this tool does and when to use it.',
  input_schema: {
    type: 'object',
    properties: {
      param1: { type: 'string', description: 'What param1 is for' },
      param2: { type: 'number', description: 'What param2 is for' },
    },
    required: ['param1'],
  },
},
```

### Step 3 — Add a case to `executeTool()` in `tools.js`

```js
case 'my_new_tool':
  return myNewTool(input);
```

### Step 4 — Wire it to an agent

**Option A — Add to an existing agent** (most common): Open the relevant agent file (e.g., `src/agent/agents/fileAgent.js`) and add your tool name to its `FILE_TOOL_NAMES` set (or equivalent):

```js
const FILE_TOOL_NAMES = new Set([
  // ... existing tools ...
  'my_new_tool',   // ← add here
]);
```

**Option B — Create a new specialist agent** (if the tool belongs to a new domain):

1. Create `src/agent/agents/myAgent.js` — copy `webAgent.js` as a template.
2. Set `toolDefs` to filter `TOOL_DEFINITIONS` for your tool(s).
3. Write a focused `SYSTEM_PROMPT`.
4. Export `async function run(task, emit)` that calls `runSpecialist()`.
5. In `src/agent/orchestrator.js`:
   - `require` your new agent.
   - Add a `call_my_agent` tool to the `ORCHESTRATOR_TOOLS` array with a clear description.
   - Add a `case 'call_my_agent':` in the tool dispatch block that calls `run(task, emit)`.
6. Update the orchestrator system prompt in `src/agent/prompts.js` to mention the new agent.

### Confirmation (write/destructive tools only)

If your tool modifies or deletes data, add its name to the `WRITE_TOOLS` set in `src/agent/agents/base.js`:

```js
const WRITE_TOOLS = new Set([
  // ... existing ...
  'my_new_tool',   // ← user must confirm before this executes
]);
```

The confirmation dialog will appear in the UI automatically — no UI code changes needed.

### Screenshot tools

If your tool returns a screenshot (base64 PNG), add its name to `SCREENSHOT_TOOLS` in `base.js`:

```js
const SCREENSHOT_TOOLS = new Set([
  // ... existing ...
  'my_new_tool',
]);
```

`base.js` will then pass the image to Claude as a multimodal content block so the model can see the screenshot.
