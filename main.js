require('dotenv').config();
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const { runAgent, resolveConfirmation } = require('./src/agent/agent');
const { initDb } = require('./src/agent/db');
const { getRealDesktopPath } = require('./src/agent/tools');
const { closeBrowser } = require('./src/agent/browserSession');
const { closeGmail } = require('./src/agent/agents/gmailSession');

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 600,
    minHeight: 500,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'Personal Desktop Agent',
    backgroundColor: '#0f172a',
  });

  if (isDev) {
    win.loadURL('http://localhost:3500');
  } else {
    win.loadFile(path.join(__dirname, 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  try {
    initDb(app.getPath('userData'));
  } catch (err) {
    console.error('Memory DB failed to initialize (memory disabled):', err);
  }
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async (e) => {
  e.preventDefault();
  try {
    await Promise.allSettled([closeBrowser(), closeGmail()]);
  } finally {
    app.exit(0);
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// IPC: confirmation response from renderer
ipcMain.handle('agent:confirm', (_event, { approved }) => {
  resolveConfirmation(approved);
  return { ok: true };
});

// Track the AbortController for the current agent run
let _currentAbortController = null;

// IPC: cancel the current agent run
ipcMain.handle('agent:stop', () => {
  if (_currentAbortController) {
    _currentAbortController.abort();
  }
  return { ok: true };
});

// IPC: handle agent messages, stream steps back to renderer
ipcMain.handle('agent:run', async (event, { message, history }) => {
  _currentAbortController = new AbortController();
  try {
    const result = await runAgent(message, history, (step) => {
      event.sender.send('agent:step', step);
    }, _currentAbortController.signal);
    return { success: true, result };
  } catch (err) {
    console.error('Agent error:', err);
    return { success: false, error: err.message };
  } finally {
    _currentAbortController = null;
  }
});
