const { chromium } = require('playwright');

// Use the real Chrome browser with the user's actual profile — Gmail sees Chrome, already logged in
const USER_DATA_DIR = 'C:\\Users\\Talb2\\AppData\\Local\\Google\\Chrome\\User Data\\Default';

let _context = null;
let _page = null;

async function getGmailPage() {
  if (!_context) {
    _context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      channel: 'chrome',
      headless: false,
      viewport: { width: 1280, height: 800 },
    });
    _page = await _context.newPage();
  } else if (!_page || _page.isClosed()) {
    _page = await _context.newPage();
  }
  return _page;
}

async function closeGmail() {
  if (_context) {
    try { await _context.close(); } catch (_) {}
    _context = null;
    _page = null;
  }
}

module.exports = { getGmailPage, closeGmail };
