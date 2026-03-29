# Personal Desktop Agent

<p align="center">
  <img src="https://img.shields.io/badge/Electron-34-47848F?style=for-the-badge&logo=electron&logoColor=white" />
  <img src="https://img.shields.io/badge/React-18-61DAFB?style=for-the-badge&logo=react&logoColor=black" />
  <img src="https://img.shields.io/badge/Claude_API-Sonnet_4.5-D97757?style=for-the-badge&logo=anthropic&logoColor=white" />
  <img src="https://img.shields.io/badge/Playwright-1.58-2EAD33?style=for-the-badge&logo=playwright&logoColor=white" />
  <img src="https://img.shields.io/badge/SQLite-3-003B57?style=for-the-badge&logo=sqlite&logoColor=white" />
  <img src="https://img.shields.io/badge/Platform-Windows-0078D6?style=for-the-badge&logo=windows&logoColor=white" />
</p>

<p align="center">
  A Windows desktop app powered by Claude that autonomously executes tasks — files, email, web, memory, and browser automation — through a multi-agent architecture.
</p>

---

## Features

- **File Operations** — search, read, create, and delete files; generate Word, Excel, PDF, and PowerPoint documents
- **Long-Term Memory** — stores and retrieves past conversations using SQLite with local semantic embeddings (`all-MiniLM-L6-v2`)
- **Email & Calendar** — search Outlook inbox, read calendar events, and manage Gmail (read, search, compose, send, draft)
- **Browser Automation** — control a real visible Chromium window with Playwright: navigate, click, type, scroll, and screenshot
- **Web Fetching** — extract content from any URL
- **Terminal Access** — run shell commands, install packages, manage processes
- **Multi-Agent Orchestration** — a top-level Claude instance routes each request to one or more specialist agents running in parallel
- **Confirmation Gate** — all write, delete, and send actions require explicit user approval before executing
- **Hebrew & English** — full RTL support in both the UI and generated documents

---

## How It Works

```
User message
    │
    ▼
Orchestrator (Claude)
    │
    ├──► FileAgent      — file system CRUD + Office file generation
    ├──► WebAgent       — URL fetch and content extraction
    ├──► BrowserAgent   — full Playwright browser automation
    ├──► GmailAgent     — Gmail via persistent Chrome profile
    ├──► OutlookAgent   — Outlook email + calendar via PowerShell COM
    ├──► MemoryAgent    — semantic memory search and storage
    └──► TerminalAgent  — shell command execution
```

Each specialist agent runs its own Claude reasoning loop with a focused tool subset. Results flow back to the orchestrator, which synthesizes the final answer. All steps stream to the UI in real time.

---

## Tech Stack

| Technology | Role |
|---|---|
| **Electron 34** | Desktop shell — native OS access, IPC bridge |
| **React 18 + Vite** | Renderer UI with HMR in development |
| **Tailwind CSS + @tailwindcss/typography** | Styling and Markdown rendering |
| **Claude API (`claude-sonnet-4-5`)** | AI reasoning for both orchestrator and all specialist agents |
| **`@anthropic-ai/sdk`** | Official Anthropic SDK with streaming support |
| **Playwright** | Headful browser automation (BrowserAgent + GmailAgent) |
| **better-sqlite3** | Embedded SQLite — conversation history and long-term memory |
| **`@xenova/transformers`** | Local `all-MiniLM-L6-v2` embeddings — no external embedding API |
| **docx / exceljs / pptxgenjs / puppeteer** | Office file generation (Word, Excel, PowerPoint, PDF) |
| **node-fetch** | HTTP fetching for WebAgent |
| **dotenv** | API key management |
| **PowerShell** | Outlook COM automation and Windows path resolution |

---

## Project Structure

```
desktop_agent/
├── main.js                    # Electron main process — window creation, IPC handlers
├── preload.js                 # contextBridge — exposes agent API to renderer
├── src/
│   ├── renderer/
│   │   ├── App.jsx            # Chat UI — streaming steps, confirmation dialogs, RTL
│   │   └── index.css          # Tailwind base + scrollbar styles
│   └── agent/
│       ├── agent.js           # Public entry point
│       ├── orchestrator.js    # Top-level routing loop
│       ├── prompts.js         # Orchestrator system prompt + memory injection
│       ├── tools.js           # All tool definitions and implementations
│       ├── db.js              # SQLite schema and CRUD helpers
│       ├── embeddings.js      # Local embedding model + similarity search
│       ├── config.js          # Shared MODEL constant
│       ├── confirm.js         # FIFO confirmation queue
│       ├── browserSession.js  # Singleton Playwright browser
│       ├── terminalSession.js # Persistent working directory state
│       └── agents/
│           ├── base.js        # Shared specialist reasoning loop (runSpecialist)
│           ├── fileAgent.js
│           ├── webAgent.js
│           ├── browserAgent.js
│           ├── gmailAgent.js
│           ├── gmailSession.js
│           ├── outlookAgent.js
│           ├── memoryAgent.js
│           └── terminalAgent.js
```

---

## Getting Started

### Prerequisites

- **Windows** (PowerShell required for Outlook COM and Desktop path resolution)
- **Node.js** 18+
- **Google Chrome** installed and logged into Gmail (for GmailAgent)
- **Microsoft Outlook** installed and running (for OutlookAgent)
- An **Anthropic API key**

### Setup

```bash
# 1. Clone the repository
git clone https://github.com/Talb2907/desktop_agent.git
cd desktop_agent

# 2. Install dependencies
npm install

# 3. Create a .env file in the project root
echo ANTHROPIC_API_KEY=your_key_here > .env

# 4. Start the app
npm run dev
```

The Vite dev server starts on `http://localhost:3500` and Electron launches automatically.

### First Run Notes

- The local embedding model (`all-MiniLM-L6-v2`, ~22 MB) is downloaded from HuggingFace on first launch — requires an internet connection.
- The SQLite database is stored in Electron's `userData` directory and persists across sessions.
- Gmail automation uses your local Chrome profile. Ensure Chrome is logged into your Gmail account before using GmailAgent.

---

## Known Limitations

| Limitation | Detail |
|---|---|
| **Windows-only** | PowerShell is required for Outlook COM and OneDrive-backed Desktop path resolution |
| **Outlook must be running** | `search_emails` and `read_calendar` use COM automation — Outlook must be open |
| **Gmail requires logged-in Chrome** | GmailAgent uses a persistent Chrome profile at the default Windows path |
| **No automated tests** | The codebase relies on manual QA |
| **PDF generation is slow** | `create_pdf_file` launches a headless Puppeteer instance (~200 MB overhead) |

---

## License

MIT
