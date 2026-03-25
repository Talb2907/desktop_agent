const { chromium } = require('playwright');

let _browser = null;
let _page = null;

/**
 * Returns the current Playwright page, launching the browser if needed.
 * Browser runs in headed mode so the user can see what is happening.
 */
async function getPage() {
  if (!_browser || !_browser.isConnected()) {
    _browser = await chromium.launch({
      headless: false,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const context = await _browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    _page = await context.newPage();
  } else if (!_page || _page.isClosed()) {
    const contexts = _browser.contexts();
    const context = contexts.length > 0
      ? contexts[0]
      : await _browser.newContext({ viewport: { width: 1280, height: 800 } });
    _page = await context.newPage();
  }
  return _page;
}

async function closeBrowser() {
  if (_browser) {
    try { await _browser.close(); } catch (_) {}
    _browser = null;
    _page = null;
  }
}

function isOpen() {
  return _browser !== null && _browser.isConnected();
}

module.exports = { getPage, closeBrowser, isOpen };
