const { TOOL_DEFINITIONS, getRealDesktopPath } = require('../tools');
const { runSpecialist } = require('./base');
const os = require('os');
const path = require('path');

const FILE_TOOL_NAMES = new Set([
  'search_files', 'read_file', 'read_excel',
  'create_file', 'append_to_file', 'delete_file', 'open_file_or_folder',
  'create_word_file', 'create_excel_file', 'create_pdf_file', 'create_powerpoint_file',
]);

const toolDefs = TOOL_DEFINITIONS.filter((t) => FILE_TOOL_NAMES.has(t.name));

function buildSystemPrompt() {
  return `You are FileAgent, a file system specialist for a Windows desktop.

Your job: search, read, and write files and folders on this machine.

Key paths:
- Home: ${os.homedir()}
- Desktop: ${getRealDesktopPath()}
- Documents: ${path.join(os.homedir(), 'Documents')}

File creation tools and when to use them:
- create_file — plain text (.txt, .md, .csv, .html, etc.)
- create_word_file — Word documents (.docx)
- create_excel_file — spreadsheets (.xlsx); use tab-separated values for columns
- create_pdf_file — PDF files (.pdf); accepts plain text or HTML content
- create_powerpoint_file — presentations (.pptx); separate slides with a blank line, first line of each block is the slide title

Rules:
- Always use absolute paths. Never use %USERNAME% or relative paths.
- For write/delete actions the user will see a confirmation dialog — call the tool once and wait.
- Never call a write tool more than once per response.
- For create_file: if the file already exists, report the file_exists result before retrying with overwrite:true.
- Be concise — summarize what you found or did, don't dump raw data.`;
}

async function run(task, emit, signal) {
  return runSpecialist({
    agentName: 'FileAgent',
    systemPrompt: buildSystemPrompt(),
    toolDefs,
    task,
    emit,
    signal,
  });
}

module.exports = { run };
