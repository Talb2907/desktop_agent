const { runOrchestrator } = require('./orchestrator');
const { resolveConfirmation } = require('./confirm');

/**
 * Public entry point — called by main.js IPC handler.
 * Signature is unchanged from Phase 1-3 so main.js needs no edits.
 *
 * @param {string}   userMessage
 * @param {Array}    history     - [{role, content}]
 * @param {Function} onStep      - Streamed step callback
 * @returns {Promise<{text: string, steps: Array}>}
 */
async function runAgent(userMessage, history = [], onStep = () => {}, signal) {
  const steps = [];

  function emit(step) {
    steps.push(step);
    onStep(step);
  }

  const text = await runOrchestrator(userMessage, history, emit, signal);
  return { text, steps };
}

module.exports = { runAgent, resolveConfirmation };
