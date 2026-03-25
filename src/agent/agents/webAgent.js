const { TOOL_DEFINITIONS } = require('../tools');
const { runSpecialist } = require('./base');

const toolDefs = TOOL_DEFINITIONS.filter((t) => t.name === 'fetch_webpage');

const SYSTEM_PROMPT = `You are WebAgent, a web content specialist.

Your job: fetch web pages and extract the information the user needs.

Rules:
- Fetch the URL, then summarize the relevant content clearly.
- If the page content is too long, focus on the most relevant sections.
- Never make up URLs — only fetch URLs explicitly provided in the task.
- Be concise in your summary.`;

async function run(task, emit) {
  return runSpecialist({
    agentName: 'WebAgent',
    systemPrompt: SYSTEM_PROMPT,
    toolDefs,
    task,
    emit,
  });
}

module.exports = { run };
