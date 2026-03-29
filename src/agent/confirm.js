// Confirmation gate with a FIFO queue.
// Multiple simultaneous write tools (e.g. from parallel specialists) are serialized:
// each waits its turn rather than racing to overwrite a single _resolve slot.

const _queue = [];

function waitForConfirmation() {
  return new Promise((resolve) => {
    _queue.push(resolve);
  });
}

function resolveConfirmation(approved) {
  const resolve = _queue.shift();
  if (resolve) resolve(approved);
}

module.exports = { waitForConfirmation, resolveConfirmation };
