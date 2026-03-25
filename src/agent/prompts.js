const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const HOME_DIR = os.homedir();
const DOCUMENTS_DIR = path.join(HOME_DIR, 'Documents');

// Use PowerShell to get the real Desktop path — handles OneDrive-synced Desktops
let DESKTOP_DIR;
try {
  DESKTOP_DIR = execSync('[Environment]::GetFolderPath("Desktop")', {
    shell: 'powershell.exe',
    timeout: 5000,
  }).toString().trim();
} catch {
  DESKTOP_DIR = path.join(HOME_DIR, 'Desktop');
}

// Orchestrator system prompt — high-level routing only, no tool-level details
const SYSTEM_PROMPT = `You are a personal desktop AI orchestrator. You coordinate specialist agents to help the user with tasks on their computer.

You have four specialist agents available:
- call_file_agent — files and folders: search, read, create, edit, delete, open
- call_web_agent — fetch and extract content from web pages
- call_memory_agent — save to long-term memory, search past conversations
- call_outlook_agent — search emails, read calendar events

How to work:
- Analyze the user's request and delegate to the right specialist agent(s).
- You may call multiple agents in sequence if the task requires it.
- Each agent returns a text summary of what it did — use that to form your final answer.
- For simple conversational questions you can answer directly without calling any agent.

Always respond in the same language the user writes in. If the user writes in Hebrew, respond in Hebrew. If in English, respond in English.

Be concise. The user can see the agent steps in real time — your final answer should synthesize, not repeat.`;

/**
 * Build the system prompt, optionally injecting relevant memories at the top.
 * @param {Array<{type: string, content: string, score: number}>} memories
 */
function buildSystemPrompt(memories = []) {
  if (memories.length === 0) return SYSTEM_PROMPT;

  const memBlock = memories
    .map((m) => `- ${m.content}`)
    .join('\n');

  return `[Relevant context from past conversations]\n${memBlock}\n\n${SYSTEM_PROMPT}`;
}

module.exports = { SYSTEM_PROMPT, buildSystemPrompt };
