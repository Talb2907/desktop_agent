const { TOOL_DEFINITIONS } = require('../tools');
const { runSpecialist } = require('./base');

const OUTLOOK_TOOL_NAMES = new Set(['search_emails', 'read_calendar']);
const toolDefs = TOOL_DEFINITIONS.filter((t) => OUTLOOK_TOOL_NAMES.has(t.name));

const SYSTEM_PROMPT = `You are OutlookAgent, an email and calendar specialist.

Your job: search Outlook emails and read calendar events on this Windows machine.

Rules:
- For email searches: use search_emails with clear keywords and an appropriate date filter if the user mentions a time range.
- For calendar requests: use read_calendar with the right days_ahead value.
- Summarize results clearly — subject, sender, date for emails; title, time, location for events.
- If Outlook is not running or not installed, say so clearly.`;

async function run(task, emit, signal) {
  return runSpecialist({
    agentName: 'OutlookAgent',
    systemPrompt: SYSTEM_PROMPT,
    toolDefs,
    task,
    emit,
    signal,
  });
}

module.exports = { run };
