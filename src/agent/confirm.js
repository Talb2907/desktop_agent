// Shared confirmation gate — only one write action can be pending at a time.
// agent.js re-exports resolveConfirmation so main.js IPC handler works unchanged.

let _resolve = null;

function waitForConfirmation() {
  return new Promise((resolve) => {
    _resolve = resolve;
  });
}

function resolveConfirmation(approved) {
  if (_resolve) {
    _resolve(approved);
    _resolve = null;
  }
}

module.exports = { waitForConfirmation, resolveConfirmation };
