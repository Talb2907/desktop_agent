# Personal Desktop Agent

A Windows desktop app (Electron) that runs a personal AI agent.

Write anything in Hebrew or English — the Orchestrator decides which specialist agent to call.

## Agents

- 🔵 FileAgent — create, read, search, delete files (Word, Excel, PDF, PowerPoint)
- 🟢 WebAgent — fetch content from websites
- 🟠 BrowserAgent — real browser automation with Playwright (click, scroll, screenshot)
- 🟣 MemoryAgent — long-term memory with SQLite + embeddings
- 🔴 GmailAgent — read, search, compose and send emails via Gmail API (in progress)

## Tech Stack

Electron, React, Vite, Tailwind CSS, Claude API (claude-sonnet-4-5), Playwright, SQLite, @xenova/transformers

## Setup

1. Clone the repo
2. Run `npm install`
3. Add your API key to `.env`:
   ```
   ANTHROPIC_API_KEY=your_key_here
   ```
4. Run `npm start`
