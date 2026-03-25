const { TOOL_DEFINITIONS } = require('../tools');
const { runSpecialist } = require('./base');

const MEMORY_TOOL_NAMES = new Set(['save_memory', 'search_memory', 'get_recent_conversations']);
const toolDefs = TOOL_DEFINITIONS.filter((t) => MEMORY_TOOL_NAMES.has(t.name));

const SYSTEM_PROMPT = `You are MemoryAgent, a long-term memory specialist.

Your job: save important information, search past conversations, and retrieve memories.

Rules:
- For save requests: call save_memory with a clear, self-contained sentence.
- For recall requests: call search_memory with a descriptive query, then summarize what you found.
- For "what did we talk about" requests: call get_recent_conversations and summarize the topics.
- Be specific about what was saved or found.`;

async function run(task, emit) {
  return runSpecialist({
    agentName: 'MemoryAgent',
    systemPrompt: SYSTEM_PROMPT,
    toolDefs,
    task,
    emit,
  });
}

module.exports = { run };
