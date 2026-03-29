const Anthropic = require('@anthropic-ai/sdk');
const { executeTool } = require('../tools');
const { waitForConfirmation } = require('../confirm');

const { MODEL } = require('../config');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MAX_ROUNDS = 15;
const SPECIALIST_TIMEOUT_MS = 120_000; // 2 minutes per specialist run

// Tools that always require user confirmation before execution
const WRITE_TOOLS = new Set([
  'create_file', 'append_to_file', 'delete_file',
  'create_word_file', 'create_excel_file', 'create_pdf_file', 'create_powerpoint_file',
  'gmail_send',
  'run_command',
  'kill_process',
]);

// Keywords that make a browser_click destructive/irreversible → require confirmation
const DESTRUCTIVE_CLICK_KEYWORDS = [
  'submit', 'confirm', 'delete', 'remove', 'purchase', 'buy', 'pay',
  'send', 'post', 'publish', 'apply', 'save changes', 'checkout', 'order',
  'sign out', 'log out', 'deactivate', 'cancel subscription',
];

function isDestructiveClick(description = '') {
  const lower = description.toLowerCase();
  return DESTRUCTIVE_CLICK_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Push a tool result onto the toolResults array.
 * If the result contains a screenshot, formats it as multimodal content so Claude can see it,
 * and emits a browser_screenshot step for the UI to render inline.
 */
function pushToolResult(toolResults, toolUse, result, tag) {
  if (result && result.screenshot) {
    tag({
      type: 'browser_screenshot',
      screenshot: result.screenshot,
      url: result.url || null,
      title: result.title || null,
      text: 'Screenshot captured',
    });
    const { screenshot, ...rest } = result;
    toolResults.push({
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: [
        { type: 'text', text: JSON.stringify(rest) },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: screenshot } },
      ],
    });
  } else {
    toolResults.push({
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: JSON.stringify(result),
    });
  }
}

/**
 * Run a specialist agent reasoning loop.
 *
 * @param {object} options
 * @param {string}   options.agentName    - Display name e.g. "FileAgent"
 * @param {string}   options.systemPrompt - Agent-specific system prompt
 * @param {Array}    options.toolDefs     - Subset of TOOL_DEFINITIONS for this agent
 * @param {string}   options.task         - Natural language task from the orchestrator
 * @param {Function} options.emit         - Step callback (adds agent tag automatically)
 * @returns {Promise<string>}             - Agent's final text answer
 */
function isAbortError(err) {
  return err?.name === 'AbortError' || err?.message?.includes('This operation was aborted');
}

async function _runSpecialistLoop({ agentName, systemPrompt, toolDefs, task, emit, signal }) {
  // Wrap emit to tag every step with the agent name
  function tag(step) {
    emit({ ...step, agent: agentName });
  }

  const messages = [{ role: 'user', content: task }];
  let finalText = null;
  let round = 0;

  try {
  while (round < MAX_ROUNDS) {
    round++;

    const stream = client.messages.stream(
      { model: MODEL, max_tokens: 4096, system: systemPrompt, tools: toolDefs, messages },
      { signal }
    ).on('text', (text) => {
      tag({ type: 'text_delta', text });
    });
    const response = await stream.finalMessage();

    const textBlocks = response.content.filter((b) => b.type === 'text');
    const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');

    if (textBlocks.length > 0 && toolUseBlocks.length === 0) {
      finalText = textBlocks.map((b) => b.text).join('');
      break;
    }

    if (response.stop_reason === 'end_turn' && toolUseBlocks.length === 0) {
      finalText = textBlocks.map((b) => b.text).join('') || '(No response)';
      break;
    }

    if (toolUseBlocks.length > 0) {
      messages.push({ role: 'assistant', content: response.content });

      const toolResults = [];

      for (const toolUse of toolUseBlocks) {
        let result;

        const needsConfirm =
          WRITE_TOOLS.has(toolUse.name) ||
          (toolUse.name === 'browser_click' && isDestructiveClick(toolUse.input.description));

        if (needsConfirm) {
          tag({
            type: 'confirm_required',
            tool: toolUse.name,
            input: toolUse.input,
            text: `Waiting for confirmation: ${toolUse.name}`,
          });

          const approved = await waitForConfirmation();

          if (!approved) {
            result = { cancelled: true, message: 'Action was cancelled by the user.' };
            tag({ type: 'tool_result', tool: toolUse.name, result, text: `${toolUse.name} cancelled` });
          } else {
            result = await executeTool(toolUse.name, toolUse.input);
            tag({ type: 'tool_result', tool: toolUse.name, result, text: `${toolUse.name} completed` });
          }
        } else {
          tag({
            type: 'tool_call',
            tool: toolUse.name,
            input: toolUse.input,
            text: `Using tool: ${toolUse.name}`,
          });

          result = await executeTool(toolUse.name, toolUse.input);

          tag({
            type: 'tool_result',
            tool: toolUse.name,
            result,
            text: `${toolUse.name} completed`,
          });
        }

        pushToolResult(toolResults, toolUse, result, tag);
      }

      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    break;
  }
  } catch (err) {
    if (isAbortError(err)) {
      return 'Task was cancelled.';
    }
    throw err;
  }

  return finalText || 'I was unable to complete this task.';
}

async function runSpecialist(options) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`${options.agentName} timed out after ${SPECIALIST_TIMEOUT_MS / 1000}s`)), SPECIALIST_TIMEOUT_MS)
  );
  return Promise.race([_runSpecialistLoop(options), timeout]);
}

module.exports = { runSpecialist, isAbortError };
