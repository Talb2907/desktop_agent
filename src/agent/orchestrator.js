const Anthropic = require('@anthropic-ai/sdk');
const { buildSystemPrompt } = require('./prompts');
const db = require('./db');
const { embed, searchSimilar } = require('./embeddings');
const fileAgent = require('./agents/fileAgent');
const webAgent = require('./agents/webAgent');
const memoryAgent = require('./agents/memoryAgent');
const outlookAgent = require('./agents/outlookAgent');
const browserAgent = require('./agents/browserAgent');
const gmailAgent = require('./agents/gmailAgent');
const terminalAgent = require('./agents/terminalAgent');

const { MODEL } = require('./config');
const { isAbortError } = require('./agents/base');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MAX_ROUNDS = 6;

// ── Orchestrator tool definitions ─────────────────────────────────────────────

const ORCHESTRATOR_TOOLS = [
  {
    name: 'call_file_agent',
    description:
      'Delegate a file system task to the FileAgent. Use for: searching files, reading files, creating/editing/deleting files, opening files or folders.',
    input_schema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Complete, self-contained description of the file task to perform.',
        },
      },
      required: ['task'],
    },
  },
  {
    name: 'call_web_agent',
    description:
      'Delegate a web fetch task to the WebAgent. Use for: fetching a URL, reading a webpage, extracting content from a link.',
    input_schema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Complete description of what to fetch and what information to extract.',
        },
      },
      required: ['task'],
    },
  },
  {
    name: 'call_memory_agent',
    description:
      'Delegate a memory task to the MemoryAgent. Use for: saving something to memory, searching past conversations, recalling what the user said before.',
    input_schema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Complete description of what to save or recall.',
        },
      },
      required: ['task'],
    },
  },
  {
    name: 'call_outlook_agent',
    description:
      'Delegate an Outlook email or calendar task to the OutlookAgent. Use for: searching Outlook emails, reading Outlook calendar events, checking meetings in Outlook. Do NOT use for Gmail.',
    input_schema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Complete description of the email or calendar task.',
        },
      },
      required: ['task'],
    },
  },
  {
    name: 'call_gmail_agent',
    description:
      'Delegate a Gmail task to the GmailAgent. Use for: reading Gmail inbox, reading Gmail emails, searching Gmail, composing emails in Gmail, sending emails via Gmail, saving Gmail drafts. Do NOT use for Outlook — use call_outlook_agent for that.',
    input_schema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Complete, self-contained description of the Gmail task to perform.',
        },
      },
      required: ['task'],
    },
  },
  {
    name: 'call_browser_agent',
    description:
      'Delegate a browser automation task to the BrowserAgent. Use for: navigating websites interactively, filling forms, logging into sites, clicking buttons, extracting data from pages that require JavaScript or user interaction. Do NOT use for simple URL fetches — use call_web_agent for that. Do NOT use for Gmail — use call_gmail_agent for that.',
    input_schema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Complete, self-contained description of the browser task, including the URL to visit.',
        },
      },
      required: ['task'],
    },
  },
  {
    name: 'call_terminal_agent',
    description:
      'Delegate a terminal/shell task to the TerminalAgent. Use for: running shell commands, installing npm/pip packages, running scripts, starting dev servers, checking git status, reading build logs or error output, killing processes. Do NOT use for simple file reads — use call_file_agent for that.',
    input_schema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Complete, self-contained description of the terminal task, including the directory to work in if relevant.',
        },
      },
      required: ['task'],
    },
  },
];

// ── Agent dispatch ────────────────────────────────────────────────────────────

const AGENT_MAP = {
  call_file_agent: fileAgent,
  call_web_agent: webAgent,
  call_memory_agent: memoryAgent,
  call_outlook_agent: outlookAgent,
  call_browser_agent: browserAgent,
  call_gmail_agent: gmailAgent,
  call_terminal_agent: terminalAgent,
};

const AGENT_DISPLAY_NAMES = {
  call_file_agent: 'FileAgent',
  call_web_agent: 'WebAgent',
  call_memory_agent: 'MemoryAgent',
  call_outlook_agent: 'OutlookAgent',
  call_browser_agent: 'BrowserAgent',
  call_gmail_agent: 'GmailAgent',
  call_terminal_agent: 'TerminalAgent',
};

// ── Memory helpers ────────────────────────────────────────────────────────────

async function getRelevantMemories(userMessage) {
  try {
    const unembedded = db.getConversationsWithoutEmbeddings();
    for (const conv of unembedded) {
      const text = `User: ${conv.user_msg}\nAssistant: ${conv.agent_reply}`;
      db.saveConversationEmbedding(conv.id, await embed(text));
    }

    const memories = db.getAllMemories().map((m) => ({ ...m, _text: m.content }));
    const conversations = db.getAllConversationEmbeddings().map((c) => ({
      ...c,
      _text: `User: ${c.user_msg}\nAssistant: ${c.agent_reply}`,
    }));

    const candidates = [...memories, ...conversations];
    if (candidates.length === 0) return [];

    const hits = await searchSimilar(userMessage, candidates, { topK: 3, minScore: 0.5 });
    return hits.map((h) => ({ content: h._text }));
  } catch {
    return [];
  }
}

// ── Main orchestrator loop ────────────────────────────────────────────────────

async function runOrchestrator(userMessage, history = [], emit, signal) {
  emit({ type: 'thinking', text: 'Thinking…', agent: 'Orchestrator' });

  const relevantMemories = await getRelevantMemories(userMessage);
  const systemPrompt = buildSystemPrompt(relevantMemories);

  const messages = [
    ...history,
    { role: 'user', content: userMessage },
  ];

  const toolCallLog = [];
  let finalText = null;
  let round = 0;

  try {
  while (round < MAX_ROUNDS) {
    round++;

    const stream = client.messages.stream(
      { model: MODEL, max_tokens: 4096, system: systemPrompt, tools: ORCHESTRATOR_TOOLS, messages },
      { signal }
    ).on('text', (text) => {
      emit({ type: 'text_delta', text, agent: 'Orchestrator' });
    });
    const response = await stream.finalMessage();

    const textBlocks = response.content.filter((b) => b.type === 'text');
    const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');

    if (textBlocks.length > 0 && toolUseBlocks.length === 0) {
      finalText = textBlocks.map((b) => b.text).join('');
      emit({ type: 'answer', text: finalText, agent: 'Orchestrator' });
      break;
    }

    if (response.stop_reason === 'end_turn' && toolUseBlocks.length === 0) {
      finalText = textBlocks.map((b) => b.text).join('') || '(No response)';
      emit({ type: 'answer', text: finalText, agent: 'Orchestrator' });
      break;
    }

    if (toolUseBlocks.length > 0) {
      messages.push({ role: 'assistant', content: response.content });

      // Run all dispatched specialists in parallel
      const settled = await Promise.all(
        toolUseBlocks.map(async (toolUse) => {
          const agentName = AGENT_DISPLAY_NAMES[toolUse.name];
          const specialist = AGENT_MAP[toolUse.name];

          emit({
            type: 'agent_handoff',
            agent: agentName,
            task: toolUse.input.task,
            text: `→ ${agentName}`,
          });

          const result = await specialist.run(toolUse.input.task, emit, signal);

          emit({
            type: 'agent_return',
            agent: agentName,
            summary: result,
            text: `← ${agentName} done`,
          });

          return { toolUse, agentName, result };
        })
      );

      const toolResults = settled.map(({ toolUse, agentName, result }) => {
        toolCallLog.push({ agent: agentName, task: toolUse.input.task, result });
        return { type: 'tool_result', tool_use_id: toolUse.id, content: result };
      });

      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    break;
  }
  } catch (err) {
    if (isAbortError(err)) {
      finalText = 'Run cancelled.';
      emit({ type: 'answer', text: finalText, agent: 'Orchestrator' });
    } else {
      throw err;
    }
  }

  if (finalText === null) {
    finalText = 'I was unable to complete the task.';
    emit({ type: 'answer', text: finalText, agent: 'Orchestrator' });
  }

  setImmediate(() => {
    try {
      db.saveConversation(userMessage, finalText, toolCallLog);
    } catch (err) {
      console.error('Failed to save conversation:', err);
    }
  });

  return finalText;
}

module.exports = { runOrchestrator };
