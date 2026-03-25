const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');
const db = require('./db');
const { embed, searchSimilar } = require('./embeddings');

// Paths that write/delete tools will never touch
const BLOCKED_WRITE_PATHS = [
  'C:\\Windows',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  process.env.WINDIR,
].filter(Boolean).map((p) => p.toLowerCase());

/**
 * Returns the real Windows Desktop path using the Shell API via PowerShell.
 * Correctly resolves OneDrive-synced Desktops (e.g. C:\Users\Talb2\OneDrive\שולחן עבודה).
 * Result is cached after the first call so PowerShell is only spawned once.
 */
let _desktopPath = null;
function getRealDesktopPath() {
  if (_desktopPath) return _desktopPath;
  try {
    _desktopPath = execSync(
      '[Environment]::GetFolderPath("Desktop")',
      { shell: 'powershell.exe', timeout: 5000 }
    ).toString().trim();
  } catch {
    _desktopPath = path.join(os.homedir(), 'Desktop');
  }
  return _desktopPath;
}

/**
 * Expand Windows environment variables and common shortcuts to real absolute paths.
 * Uses getRealDesktopPath() for Desktop (OneDrive-aware) and os.homedir() for user paths.
 * Relative paths are resolved against os.homedir(), never process.cwd().
 */
function resolvePath(filePath) {
  const home = os.homedir();
  const username = path.basename(home);
  const desktop = getRealDesktopPath();

  const expanded = filePath
    .replace(/%USERPROFILE%/gi, home)
    .replace(/%HOMEPATH%/gi, home)
    .replace(/%USERNAME%/gi, username)
    .replace(/%DESKTOP%/gi, desktop)
    .replace(/%DOCUMENTS%/gi, path.join(home, 'Documents'))
    .replace(/%DOWNLOADS%/gi, path.join(home, 'Downloads'))
    .replace(/%TEMP%/gi, os.tmpdir())
    .replace(/^~[/\\]/, home + path.sep)
    .replace(/^~$/, home)
    // Bare "Desktop\..." relative path → real OneDrive Desktop
    .replace(/^Desktop[/\\]/i, desktop + path.sep);

  // If still relative after expansion, anchor to home dir — never to cwd
  return path.isAbsolute(expanded)
    ? path.normalize(expanded)
    : path.join(home, expanded);
}

function isBlockedPath(filePath) {
  const normalized = resolvePath(filePath).toLowerCase();
  return BLOCKED_WRITE_PATHS.some((blocked) => normalized.startsWith(blocked));
}

// ── Tool definitions for Claude API ──────────────────────────────────────────

const TOOL_DEFINITIONS = [
  {
    name: 'search_files',
    description:
      'Search for files and folders recursively on the local machine by name, pattern, or content. Returns results sorted by most recently modified.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'File name or glob pattern to search for (e.g. "report", "*.pdf", "budget*2024"). Automatically wrapped with wildcards unless the query already contains one.',
        },
        path: {
          type: 'string',
          description:
            'Directory to search in. Defaults to the user home directory. Use a drive letter like "C:\\" to search the whole drive.',
        },
        search_content: {
          type: 'boolean',
          description:
            'If true, also search inside file contents (text files only) for the query string. Slower but finds matches beyond file names.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_file',
    description: 'Read the contents of a file from disk.',
    input_schema: {
      type: 'object',
      properties: {
        filepath: {
          type: 'string',
          description: 'Absolute or relative path to the file.',
        },
      },
      required: ['filepath'],
    },
  },
  {
    name: 'search_emails',
    description: 'Search Outlook emails on this Windows machine using PowerShell.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Keywords to search for in email subject or body.',
        },
        date_filter: {
          type: 'string',
          enum: ['today', 'week', 'month'],
          description: 'Optional date range filter.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_calendar',
    description: 'Read upcoming calendar events from Outlook via PowerShell.',
    input_schema: {
      type: 'object',
      properties: {
        days_ahead: {
          type: 'number',
          description: 'How many days ahead to look. Default is 7.',
        },
      },
      required: [],
    },
  },
  {
    name: 'read_excel',
    description:
      'Read the contents of an Excel file (.xlsx, .xls, .csv). Returns each sheet as a table of rows. Use this instead of read_file for spreadsheets.',
    input_schema: {
      type: 'object',
      properties: {
        filepath: {
          type: 'string',
          description: 'Absolute path to the Excel or CSV file.',
        },
        sheet: {
          type: 'string',
          description:
            'Sheet name to read. If omitted, all sheets are returned. Use this to target a specific sheet.',
        },
        max_rows: {
          type: 'number',
          description: 'Maximum rows to return per sheet. Defaults to 200.',
        },
      },
      required: ['filepath'],
    },
  },
  {
    name: 'save_memory',
    description:
      'Save something important to long-term memory. Use this when the user explicitly asks you to remember something, or when you learn a preference, fact, or decision that will be useful in future conversations.',
    input_schema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The information to remember. Write it as a clear, self-contained sentence.',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'search_memory',
    description:
      'Semantic search over past conversations and saved memories. Use this when the user refers to something you may have discussed before, or when context from the past would help answer the current question.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What to search for in memory.',
        },
        limit: {
          type: 'number',
          description: 'Max results to return. Default 5.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_recent_conversations',
    description: 'Retrieve the most recent conversation turns from memory.',
    input_schema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Number of recent conversations to return. Default 10.',
        },
      },
      required: [],
    },
  },
  {
    name: 'create_file',
    description:
      'Create a new file with the given content. If the file already exists, returns a file_exists signal — do NOT set overwrite:true unless the user has explicitly confirmed they want to replace it.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path for the new file.' },
        content: { type: 'string', description: 'Text content to write.' },
        overwrite: {
          type: 'boolean',
          description: 'Set true only after user has explicitly approved overwriting an existing file.',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'append_to_file',
    description: 'Append text to an existing file. Creates the file if it does not exist.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file.' },
        content: { type: 'string', description: 'Text to append.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'delete_file',
    description:
      'Move a file to the Recycle Bin (recoverable). Never use this without user confirmation.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file to delete.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'open_file_or_folder',
    description:
      'Open a file in its default application, or open a folder in Windows Explorer. Does not modify anything.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file or folder to open.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'create_word_file',
    description: 'Create a .docx Word document from plain text content.',
    input_schema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Filename including .docx extension, e.g. "report.docx".' },
        content:  { type: 'string', description: 'Plain text content. Each newline becomes a new paragraph.' },
        path:     { type: 'string', description: 'Directory to save in. Defaults to Desktop.' },
      },
      required: ['filename', 'content'],
    },
  },
  {
    name: 'create_excel_file',
    description: 'Create a .xlsx Excel spreadsheet from plain text content.',
    input_schema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Filename including .xlsx extension, e.g. "data.xlsx".' },
        content:  { type: 'string', description: 'Plain text. Each line = one row. Tab-separated values become columns.' },
        path:     { type: 'string', description: 'Directory to save in. Defaults to Desktop.' },
      },
      required: ['filename', 'content'],
    },
  },
  {
    name: 'create_pdf_file',
    description: 'Create a .pdf file from plain text or HTML content using a headless browser.',
    input_schema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Filename including .pdf extension, e.g. "report.pdf".' },
        content:  { type: 'string', description: 'Plain text or HTML. Plain text is auto-wrapped in an HTML template.' },
        path:     { type: 'string', description: 'Directory to save in. Defaults to Desktop.' },
      },
      required: ['filename', 'content'],
    },
  },
  {
    name: 'create_powerpoint_file',
    description: 'Create a .pptx PowerPoint presentation from plain text content.',
    input_schema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Filename including .pptx extension, e.g. "slides.pptx".' },
        content:  { type: 'string', description: 'Plain text. Separate slides with a blank line (double newline). First line of each block is the slide title.' },
        path:     { type: 'string', description: 'Directory to save in. Defaults to Desktop.' },
      },
      required: ['filename', 'content'],
    },
  },
  {
    name: 'fetch_webpage',
    description: 'Fetch and extract readable text content from a URL.',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to fetch.',
        },
      },
      required: ['url'],
    },
  },

  // ── Browser automation tools ──────────────────────────────────────────────
  {
    name: 'browser_open',
    description:
      'Open a URL in a real browser window. Returns a screenshot of the loaded page. Use this to start a browser session.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL to navigate to, including https://.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_click',
    description:
      'Click an element on the current browser page. Returns a screenshot after clicking. Use Playwright locator syntax: CSS selectors, "text=Sign in", "role=button[name=Submit]".',
    input_schema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'Playwright locator string, e.g. "text=Submit", "button.primary", "role=link[name=Home]".',
        },
        description: {
          type: 'string',
          description: 'Human-readable description of what you are clicking (shown in confirmation dialog).',
        },
      },
      required: ['selector', 'description'],
    },
  },
  {
    name: 'browser_type',
    description:
      'Type text into an input field on the current browser page. Clears the field first, then types. Returns a screenshot after typing.',
    input_schema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'Playwright locator for the input field, e.g. "input[name=email]", "role=textbox[name=Username]".',
        },
        text: { type: 'string', description: 'Text to type into the field.' },
      },
      required: ['selector', 'text'],
    },
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the current browser page up or down.',
    input_schema: {
      type: 'object',
      properties: {
        direction: {
          type: 'string',
          enum: ['up', 'down'],
          description: 'Direction to scroll.',
        },
        pixels: {
          type: 'number',
          description: 'How many pixels to scroll. Default 500.',
        },
      },
      required: ['direction'],
    },
  },
  {
    name: 'browser_screenshot',
    description: 'Take a screenshot of the current browser page and show it in the UI.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'browser_extract',
    description:
      'Extract visible text from the current browser page or from a specific element. Useful for reading page content after navigation.',
    input_schema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'Optional Playwright locator to extract from a specific element. If omitted, extracts all visible page text.',
        },
      },
      required: [],
    },
  },
  {
    name: 'browser_close',
    description: 'Close the browser session. Call this when the browsing task is complete.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  // ── Gmail tools ──────────────────────────────────────────────────────────────

  {
    name: 'gmail_open_inbox',
    description:
      'Navigate to Gmail inbox in the persistent browser session and take a screenshot. Use this to start a Gmail session or return to the inbox.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'gmail_read_emails',
    description:
      'Extract a structured list of recent or unread emails from the current Gmail inbox view. Returns sender, subject, preview, date, and read/unread status for each email.',
    input_schema: {
      type: 'object',
      properties: {
        max: {
          type: 'number',
          description: 'Maximum number of emails to return. Default 10.',
        },
      },
      required: [],
    },
  },
  {
    name: 'gmail_read_email',
    description:
      'Open a specific email and extract its full content (sender, subject, date, body). Identify the email by its 1-based index in the current list, or by matching subject text.',
    input_schema: {
      type: 'object',
      properties: {
        index: {
          type: 'number',
          description: '1-based position in the current email list.',
        },
        subject_match: {
          type: 'string',
          description: 'Partial subject text to search for when index is not known.',
        },
      },
      required: [],
    },
  },
  {
    name: 'gmail_search',
    description:
      'Search Gmail using a query string. Supports standard Gmail operators: from:, to:, subject:, has:attachment, is:unread, after:YYYY/MM/DD, before:YYYY/MM/DD, etc.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Gmail search query string.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'gmail_compose',
    description:
      'Open the Gmail compose window and fill in the To, Subject, and Body fields. Does NOT send the email — call gmail_send after this to send, or gmail_create_draft to save.',
    input_schema: {
      type: 'object',
      properties: {
        to:      { type: 'string', description: 'Recipient email address.' },
        subject: { type: 'string', description: 'Email subject line.' },
        body:    { type: 'string', description: 'Full email body text.' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'gmail_send',
    description:
      'Send the currently composed email. ALWAYS requires explicit user confirmation before sending. Call gmail_compose first, then this tool. Pass to/subject/body_preview so the confirmation dialog can show the full email to the user.',
    input_schema: {
      type: 'object',
      properties: {
        to:           { type: 'string', description: 'Recipient — shown in confirmation dialog.' },
        subject:      { type: 'string', description: 'Subject — shown in confirmation dialog.' },
        body_preview: { type: 'string', description: 'First 500 characters of the body — shown in confirmation dialog.' },
      },
      required: ['to', 'subject', 'body_preview'],
    },
  },
  {
    name: 'gmail_create_draft',
    description:
      'Save the current compose window as a draft by closing it. Gmail auto-saves the draft.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
];

// ── Tool implementations ──────────────────────────────────────────────────────

async function searchFiles({ query, path: searchPath, search_content = false }) {
  const baseDir = searchPath || os.homedir();

  // Wrap with wildcards only if the query doesn't already contain one
  const namePattern = /[*?]/.test(query) ? query : `*${query}*`;

  // Directories to skip — noisy, system, or very large
  const skipDirs = ['node_modules', '.git', '$Recycle.Bin', 'AppData\\Local\\Temp', 'Windows\\WinSxS'];

  const escapedQuery = query.replace(/'/g, "''");
  const contentBlock = search_content
    ? `
$textExts = @('.txt','.md','.csv','.log','.json','.xml','.html','.js','.ts','.py','.cs','.java','.ps1','.bat','.ini','.cfg','.yaml','.yml')
$contentHits = Get-ChildItem -Path $baseDir -Recurse -File -ErrorAction SilentlyContinue -Force |
  Where-Object {
    $p = $_.FullName
    $skip = $false
    foreach ($d in $skipDirs) { if ($p -like "*\\$d\\*" -or $p -like "*\\$d") { $skip = $true; break } }
    !$skip -and ($textExts -contains $_.Extension.ToLower()) -and ($_.Length -lt 2MB)
  } |
  Where-Object { (Get-Content $_.FullName -Raw -Encoding UTF8 -ErrorAction SilentlyContinue) -match [regex]::Escape('${escapedQuery}') } |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 20
$contentHits | Where-Object { $nameResults.FullName -notcontains $_.FullName } | ForEach-Object {
  $size = "$([math]::Round($_.Length / 1KB, 1)) KB"
  "$($_.FullName)|file (content match)|$size|$($_.LastWriteTime.ToString('yyyy-MM-dd HH:mm'))"
}`
    : '';

  const ps = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$baseDir = '${baseDir.replace(/'/g, "''")}'
$pattern = '${namePattern.replace(/'/g, "''")}'
$skipDirs = @('node_modules', '.git', '$Recycle.Bin', 'AppData\\Local\\Temp', 'Windows\\WinSxS')

# Use -Filter for Win32-level Unicode matching, then Where-Object only for dir exclusion
$nameResults = Get-ChildItem -Path $baseDir -Filter $pattern -Recurse -ErrorAction SilentlyContinue -Force |
  Where-Object {
    $p = $_.FullName
    $skip = $false
    foreach ($d in $skipDirs) { if ($p -like "*\\$d\\*" -or $p -like "*\\$d") { $skip = $true; break } }
    !$skip
  } |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 50

$nameResults | ForEach-Object {
  $type = if ($_.PSIsContainer) { 'folder' } else { 'file' }
  $size = if ($_.PSIsContainer) { '' } else { "$([math]::Round($_.Length / 1KB, 1)) KB" }
  "$($_.FullName)|$type|$size|$($_.LastWriteTime.ToString('yyyy-MM-dd HH:mm'))"
}
${contentBlock}
`;

  // Write with UTF-8 BOM so PowerShell 5.1 correctly reads Hebrew/non-ASCII characters
  const BOM = '\uFEFF';
  const tmpFile = path.join(os.tmpdir(), `agent_search_${Date.now()}.ps1`);
  try {
    fs.writeFileSync(tmpFile, BOM + ps, 'utf8');

    const output = execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpFile}"`,
      { timeout: 30000, encoding: 'utf8' }
    ).trim();

    if (!output) {
      return {
        found: 0,
        results: [],
        message: `No files found matching "${query}" in ${baseDir}.`,
      };
    }

    const results = output
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const parts = line.trim().split('|');
        return { path: parts[0], type: parts[1], size: parts[2], modified: parts[3] };
      });

    return { found: results.length, query, namePattern, searchPath: baseDir, results };
  } catch (err) {
    return { error: `Search failed: ${err.message}` };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }
}

function readFile({ filepath }) {
  try {
    if (!fs.existsSync(filepath)) {
      return { error: `File not found: ${filepath}` };
    }

    const stats = fs.statSync(filepath);
    if (stats.isDirectory()) {
      const entries = fs.readdirSync(filepath).slice(0, 50);
      return { type: 'directory', path: filepath, entries };
    }

    const MAX_CHARS = 5000;
    const raw = fs.readFileSync(filepath, 'utf8');
    const content = raw.slice(0, MAX_CHARS);
    const truncated = raw.length > MAX_CHARS;

    return {
      path: filepath,
      size: `${(stats.size / 1024).toFixed(1)} KB`,
      content,
      truncated,
      totalChars: raw.length,
    };
  } catch (err) {
    return { error: `Could not read file: ${err.message}` };
  }
}

function readExcel({ filepath, sheet: sheetName, max_rows = 200 }) {
  try {
    if (!fs.existsSync(filepath)) return { error: `File not found: ${filepath}` };

    const XLSX = require('xlsx');
    const workbook = XLSX.readFile(filepath, { cellDates: true, dense: false });
    const limit = Math.min(Math.max(Number(max_rows) || 200, 1), 1000);

    const targetSheets = sheetName
      ? [sheetName]
      : workbook.SheetNames;

    if (sheetName && !workbook.SheetNames.includes(sheetName)) {
      return {
        error: `Sheet "${sheetName}" not found.`,
        available_sheets: workbook.SheetNames,
      };
    }

    const sheets = {};
    for (const name of targetSheets) {
      const ws = workbook.Sheets[name];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: false });
      const trimmed = rows.slice(0, limit);
      sheets[name] = {
        rows: trimmed,
        total_rows: rows.length,
        truncated: rows.length > limit,
      };
    }

    return {
      filepath,
      sheet_names: workbook.SheetNames,
      sheets,
    };
  } catch (err) {
    return { error: `Could not read Excel file: ${err.message}` };
  }
}

function searchEmails({ query, date_filter }) {
  try {
    const escapedQuery = query.replace(/'/g, "''");

    let dateClause = '';
    if (date_filter === 'today') {
      dateClause = `$_.ReceivedTime -gt (Get-Date).Date -and `;
    } else if (date_filter === 'week') {
      dateClause = `$_.ReceivedTime -gt (Get-Date).AddDays(-7) -and `;
    } else if (date_filter === 'month') {
      dateClause = `$_.ReceivedTime -gt (Get-Date).AddDays(-30) -and `;
    }

    const ps = `
      Add-Type -AssemblyName 'Microsoft.Office.Interop.Outlook' -ErrorAction SilentlyContinue
      try {
        $outlook = New-Object -ComObject Outlook.Application -ErrorAction Stop
        $ns = $outlook.GetNamespace('MAPI')
        $inbox = $ns.GetDefaultFolder(6)
        $items = $inbox.Items
        $items.Sort('[ReceivedTime]', $true)
        $results = $items | Where-Object { ${dateClause}($_.Subject -like '*${escapedQuery}*' -or $_.Body -like '*${escapedQuery}*') } | Select-Object -First 10
        $results | ForEach-Object {
          $preview = $_.Body -replace '\s+', ' '
          if ($preview.Length -gt 150) { $preview = $preview.Substring(0, 150) + '...' }
          "$($_.Subject)|$($_.SenderName)|$($_.ReceivedTime.ToString('yyyy-MM-dd HH:mm'))|$preview"
        }
      } catch {
        Write-Output "ERROR: $_"
      }
    `;

    const output = execSync(
      `powershell -NoProfile -Command "${ps.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`,
      { timeout: 20000, encoding: 'utf8' }
    ).trim();

    if (output.startsWith('ERROR:')) {
      return { error: output, hint: 'Make sure Outlook is installed and running.' };
    }

    if (!output) return { found: 0, emails: [], message: 'No matching emails found.' };

    const emails = output
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [subject, sender, received, preview] = line.trim().split('|');
        return { subject, sender, received, preview };
      });

    return { found: emails.length, emails };
  } catch (err) {
    return { error: `Email search failed: ${err.message}` };
  }
}

function readCalendar({ days_ahead = 7 } = {}) {
  try {
    const days = Math.min(Math.max(Number(days_ahead) || 7, 1), 90);

    const ps = `
      Add-Type -AssemblyName 'Microsoft.Office.Interop.Outlook' -ErrorAction SilentlyContinue
      try {
        $outlook = New-Object -ComObject Outlook.Application -ErrorAction Stop
        $ns = $outlook.GetNamespace('MAPI')
        $cal = $ns.GetDefaultFolder(9)
        $items = $cal.Items
        $items.IncludeRecurrences = $true
        $items.Sort('[Start]')
        $start = (Get-Date).ToString('g')
        $end = (Get-Date).AddDays(${days}).ToString('g')
        $filter = "[Start] >= '$start' AND [Start] <= '$end'"
        $events = $items.Restrict($filter) | Select-Object -First 20
        $events | ForEach-Object {
          "$($_.Subject)|$($_.Start.ToString('yyyy-MM-dd HH:mm'))|$($_.End.ToString('HH:mm'))|$($_.Location)"
        }
      } catch {
        Write-Output "ERROR: $_"
      }
    `;

    const output = execSync(
      `powershell -NoProfile -Command "${ps.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`,
      { timeout: 20000, encoding: 'utf8' }
    ).trim();

    if (output.startsWith('ERROR:')) {
      return { error: output, hint: 'Make sure Outlook is installed and running.' };
    }

    if (!output) return { found: 0, events: [], message: `No events in the next ${days} days.` };

    const events = output
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [title, start, end, location] = line.trim().split('|');
        return { title, start, end, location };
      });

    return { found: events.length, days_ahead: days, events };
  } catch (err) {
    return { error: `Calendar read failed: ${err.message}` };
  }
}

async function saveMemory({ content }) {
  try {
    const embedding = await embed(content);
    const id = db.saveMemory(content, embedding);
    return { saved: true, id };
  } catch (err) {
    return { error: `Failed to save memory: ${err.message}` };
  }
}

async function searchMemory({ query, limit = 5 }) {
  try {
    // Lazily embed any conversations that don't have embeddings yet
    const unembedded = db.getConversationsWithoutEmbeddings();
    for (const conv of unembedded) {
      const text = `User: ${conv.user_msg}\nAssistant: ${conv.agent_reply}`;
      const emb = await embed(text);
      db.saveConversationEmbedding(conv.id, emb);
    }

    const memories = db.getAllMemories().map((m) => ({ ...m, _type: 'memory' }));
    const conversations = db.getAllConversationEmbeddings().map((c) => ({ ...c, _type: 'conversation' }));
    const candidates = [...memories, ...conversations];

    const hits = await searchSimilar(query, candidates, { topK: limit, minScore: 0.3 });

    const results = hits.map(({ _type, id, created_at, content, user_msg, agent_reply, score }) => ({
      type: _type,
      id,
      created_at: new Date(created_at).toISOString(),
      content: _type === 'memory' ? content : `User: ${user_msg}\nAssistant: ${agent_reply}`,
      score: Math.round(score * 100) / 100,
    }));

    return { found: results.length, query, results };
  } catch (err) {
    return { error: `Memory search failed: ${err.message}` };
  }
}

function getRecentConversations({ limit = 10 } = {}) {
  try {
    const rows = db.getRecentConversations(Math.min(Number(limit) || 10, 50));
    const conversations = rows.map((r) => ({
      id: r.id,
      created_at: new Date(r.created_at).toISOString(),
      user_msg: r.user_msg,
      agent_reply: r.agent_reply,
      tool_calls: JSON.parse(r.tool_calls || '[]'),
    }));
    return { found: conversations.length, conversations };
  } catch (err) {
    return { error: `Failed to retrieve conversations: ${err.message}` };
  }
}

function createFile({ path: filePath, content, overwrite = false }) {
  try {
    if (isBlockedPath(filePath)) return { error: `Writes to system directories are not allowed.` };
    const absPath = resolvePath(filePath);
    if (fs.existsSync(absPath) && !overwrite) {
      const stat = fs.statSync(absPath);
      return {
        file_exists: true,
        path: absPath,
        size: `${(stat.size / 1024).toFixed(1)} KB`,
        modified: stat.mtime.toISOString(),
      };
    }
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, 'utf8');
    return { created: true, path: absPath };
  } catch (err) {
    return { error: `create_file failed: ${err.message}` };
  }
}

function appendToFile({ path: filePath, content }) {
  try {
    if (isBlockedPath(filePath)) return { error: `Writes to system directories are not allowed.` };
    const absPath = resolvePath(filePath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.appendFileSync(absPath, content, 'utf8');
    return { appended: true, path: absPath, bytes_added: Buffer.byteLength(content, 'utf8') };
  } catch (err) {
    return { error: `append_to_file failed: ${err.message}` };
  }
}

function deleteFile({ path: filePath }) {
  try {
    if (isBlockedPath(filePath)) return { error: `Deleting system files is not allowed.` };
    const absPath = resolvePath(filePath);
    if (!fs.existsSync(absPath)) return { error: `File not found: ${absPath}` };

    // Move to Recycle Bin via PowerShell Shell.Application (recoverable)
    const escaped = absPath.replace(/'/g, "''");
    execSync(
      `powershell -NoProfile -Command "(New-Object -ComObject Shell.Application).Namespace(0).ParseName('${escaped}').InvokeVerb('delete')"`,
      { timeout: 10000 }
    );
    return { deleted: true, path: absPath };
  } catch (err) {
    return { error: `delete_file failed: ${err.message}` };
  }
}

async function openFileOrFolder({ path: filePath }) {
  try {
    const absPath = resolvePath(filePath);
    if (!fs.existsSync(absPath)) return { error: `Path not found: ${absPath}` };
    // Use Electron shell — available in main process
    const { shell } = require('electron');
    const errMsg = await shell.openPath(absPath);
    if (errMsg) return { error: errMsg };
    return { opened: true, path: absPath };
  } catch (err) {
    return { error: `open_file_or_folder failed: ${err.message}` };
  }
}

// ── Rich file creation helpers ────────────────────────────────────────────────

function resolveOutputPath(filename, dirPath) {
  const dir = dirPath ? resolvePath(dirPath) : getRealDesktopPath();
  const fullPath = resolvePath(path.join(dir, filename));
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  return fullPath;
}

async function createWordFile({ filename, content, path: dirPath }) {
  try {
    const { Document, Packer, Paragraph, TextRun } = require('docx');
    const absPath = resolveOutputPath(filename, dirPath);

    const paragraphs = content.split('\n').map(
      (line) => new Paragraph({ children: [new TextRun(line)] })
    );

    const doc = new Document({ sections: [{ children: paragraphs }] });
    const buffer = await Packer.toBuffer(doc);
    fs.writeFileSync(absPath, buffer);
    return { created: true, path: absPath };
  } catch (err) {
    return { error: `create_word_file failed: ${err.message}` };
  }
}

async function createExcelFile({ filename, content, path: dirPath }) {
  try {
    const ExcelJS = require('exceljs');
    const absPath = resolveOutputPath(filename, dirPath);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Sheet1');

    const lines = content.split('\n').filter((l) => l.trim() !== '' || true);
    lines.forEach((line) => {
      const cells = line.split('\t');
      sheet.addRow(cells);
    });

    await workbook.xlsx.writeFile(absPath);
    return { created: true, path: absPath, rows: lines.length };
  } catch (err) {
    return { error: `create_excel_file failed: ${err.message}` };
  }
}

async function createPdfFile({ filename, content, path: dirPath }) {
  try {
    const puppeteer = require('puppeteer');
    const absPath = resolveOutputPath(filename, dirPath);

    // Wrap plain text in an HTML template; pass through if already HTML
    const isHtml = /^\s*</.test(content);
    const html = isHtml ? content : `<!DOCTYPE html><html><head>
      <meta charset="utf-8">
      <style>body { font-family: Arial, sans-serif; padding: 40px; font-size: 14px; line-height: 1.6; }</style>
      </head><body><pre style="white-space:pre-wrap;">${content.replace(/</g, '&lt;')}</pre></body></html>`;

    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.pdf({ path: absPath, format: 'A4', printBackground: true });
    await browser.close();

    return { created: true, path: absPath };
  } catch (err) {
    return { error: `create_pdf_file failed: ${err.message}` };
  }
}

async function createPowerpointFile({ filename, content, path: dirPath }) {
  try {
    const PptxGenJS = require('pptxgenjs');
    const absPath = resolveOutputPath(filename, dirPath);

    const pptx = new PptxGenJS();

    // Split into slides on blank lines; first line of each block = title
    const slideBlocks = content.split(/\n\n+/).filter((b) => b.trim());

    for (const block of slideBlocks) {
      const lines = block.trim().split('\n');
      const title = lines[0];
      const body = lines.slice(1).join('\n').trim();

      const slide = pptx.addSlide();
      slide.addText(title, {
        x: 0.5, y: 0.3, w: 9, h: 0.8,
        fontSize: 28, bold: true, color: '363636',
      });
      if (body) {
        slide.addText(body, {
          x: 0.5, y: 1.3, w: 9, h: 5,
          fontSize: 18, color: '555555', valign: 'top',
        });
      }
    }

    if (slideBlocks.length === 0) pptx.addSlide(); // at least one slide
    await pptx.writeFile({ fileName: absPath });
    return { created: true, path: absPath, slides: slideBlocks.length };
  } catch (err) {
    return { error: `create_powerpoint_file failed: ${err.message}` };
  }
}

async function fetchWebpage({ url }) {
  try {
    // Dynamic import for ESM node-fetch
    const { default: fetch } = await import('node-fetch');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Desktop Agent/1.0)' },
    });
    clearTimeout(timeout);

    const html = await res.text();

    // Strip HTML tags and collapse whitespace
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\s{2,}/g, ' ')
      .trim();

    // Extract title
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : url;

    const MAX_CHARS = 3000;
    const content = text.slice(0, MAX_CHARS);
    const truncated = text.length > MAX_CHARS;

    return { url, title, content, truncated, totalChars: text.length };
  } catch (err) {
    return { error: `Fetch failed: ${err.message}` };
  }
}

// ── Browser automation implementations ───────────────────────────────────────

async function browserOpen({ url }) {
  try {
    const { getPage } = require('./browserSession');
    const page = await getPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(800);
    const title = await page.title();
    const screenshot = await page.screenshot({ type: 'png' });
    return { navigated: true, url, title, screenshot: screenshot.toString('base64') };
  } catch (err) {
    return { error: `browser_open failed: ${err.message}` };
  }
}

async function browserClick({ selector, description }) {
  try {
    const { getPage } = require('./browserSession');
    const page = await getPage();
    await page.locator(selector).first().click({ timeout: 10000 });
    await page.waitForTimeout(600);
    return { clicked: true, selector, description };
  } catch (err) {
    return { error: `browser_click failed: ${err.message}` };
  }
}

async function browserType({ selector, text }) {
  try {
    const { getPage } = require('./browserSession');
    const page = await getPage();
    await page.locator(selector).first().fill(text, { timeout: 10000 });
    await page.waitForTimeout(400);
    return { typed: true, selector, text };
  } catch (err) {
    return { error: `browser_type failed: ${err.message}` };
  }
}

async function browserScroll({ direction = 'down', pixels = 500 }) {
  try {
    const { getPage } = require('./browserSession');
    const page = await getPage();
    const delta = direction === 'up' ? -Math.abs(pixels) : Math.abs(pixels);
    await page.evaluate((dy) => window.scrollBy(0, dy), delta);
    return { scrolled: true, direction, pixels };
  } catch (err) {
    return { error: `browser_scroll failed: ${err.message}` };
  }
}

async function browserScreenshot() {
  try {
    const { getPage } = require('./browserSession');
    const page = await getPage();
    const screenshot = await page.screenshot({ type: 'png' });
    const url = page.url();
    const title = await page.title();
    return { screenshot: screenshot.toString('base64'), url, title };
  } catch (err) {
    return { error: `browser_screenshot failed: ${err.message}` };
  }
}

async function browserExtract({ selector } = {}) {
  try {
    const { getPage } = require('./browserSession');
    const page = await getPage();
    let text;
    if (selector) {
      text = await page.locator(selector).first().innerText({ timeout: 10000 });
    } else {
      text = await page.evaluate(() => document.body.innerText);
    }
    const MAX = 4000;
    return {
      text: text.slice(0, MAX),
      truncated: text.length > MAX,
      totalChars: text.length,
      url: page.url(),
    };
  } catch (err) {
    return { error: `browser_extract failed: ${err.message}` };
  }
}

async function browserClose() {
  try {
    const { closeBrowser } = require('./browserSession');
    await closeBrowser();
    return { closed: true };
  } catch (err) {
    return { error: `browser_close failed: ${err.message}` };
  }
}

// ── Gmail implementations ─────────────────────────────────────────────────────

async function gmailOpenInbox() {
  try {
    const { getGmailPage } = require('./agents/gmailSession');
    const page = await getGmailPage();
    await page.goto('https://mail.google.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Wait for inbox rows or any Gmail UI element
    await page.waitForSelector('tr.zA, [data-view-type="1"], .nH', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1000);
    const title = await page.title();
    const screenshot = await page.screenshot({ type: 'png' });
    const onLoginPage = title.toLowerCase().includes('sign in') || page.url().includes('accounts.google');
    return {
      navigated: true,
      url: page.url(),
      title,
      loggedIn: !onLoginPage,
      screenshot: screenshot.toString('base64'),
    };
  } catch (err) {
    return { error: `gmail_open_inbox failed: ${err.message}` };
  }
}

async function gmailReadEmails({ max = 10 } = {}) {
  try {
    const { getGmailPage } = require('./agents/gmailSession');
    const page = await getGmailPage();
    await page.waitForSelector('tr.zA', { timeout: 10000 });
    const emails = await page.$$eval('tr.zA', (rows, limit) => {
      return rows.slice(0, limit).map((row, i) => {
        const senderEl = row.querySelector('.zF');
        const subjectEl = row.querySelector('.bog') || row.querySelector('.bqe');
        const previewEl = row.querySelector('.y2');
        const dateEl = row.querySelector('.xW span') || row.querySelector('.xW') || row.querySelector('.xS');
        return {
          index: i + 1,
          sender: senderEl?.getAttribute('name') || senderEl?.textContent?.trim() || '',
          subject: subjectEl?.textContent?.trim() || '',
          preview: previewEl?.textContent?.trim() || '',
          date: dateEl?.getAttribute('title') || dateEl?.textContent?.trim() || '',
          unread: row.classList.contains('zE'),
        };
      });
    }, max);
    return { emails, count: emails.length };
  } catch (err) {
    return { error: `gmail_read_emails failed: ${err.message}` };
  }
}

async function gmailReadEmail({ index, subject_match } = {}) {
  try {
    const { getGmailPage } = require('./agents/gmailSession');
    const page = await getGmailPage();
    await page.waitForSelector('tr.zA', { timeout: 10000 });

    let targetRow = null;
    const rows = await page.$$('tr.zA');

    if (index && rows[index - 1]) {
      targetRow = rows[index - 1];
    } else if (subject_match) {
      for (const row of rows) {
        const subj = await row.$eval('.bog, .bqe', (el) => el.textContent.trim()).catch(() => '');
        if (subj.toLowerCase().includes(subject_match.toLowerCase())) {
          targetRow = row;
          break;
        }
      }
    }

    if (!targetRow) return { error: 'Email not found. Check the index or subject text.' };

    await targetRow.click();
    await page.waitForTimeout(2000);
    await page.waitForSelector('.hP, .ii.gt', { timeout: 8000 }).catch(() => {});

    const subject = await page.$eval('.hP', (el) => el.textContent.trim()).catch(() => '');
    const sender = await page.$eval('.gD', (el) => el.getAttribute('email') || el.textContent.trim()).catch(() => '');
    const date = await page.$eval('.g3', (el) => el.getAttribute('title') || el.textContent.trim()).catch(() => '');
    const body = await page.$eval('.a3s.aiL', (el) => el.innerText.trim())
      .catch(() => page.$eval('.ii.gt', (el) => el.innerText.trim()).catch(() => ''));

    const MAX = 5000;
    return {
      subject,
      sender,
      date,
      body: body.slice(0, MAX),
      truncated: body.length > MAX,
    };
  } catch (err) {
    return { error: `gmail_read_email failed: ${err.message}` };
  }
}

async function gmailSearch({ query }) {
  try {
    const { getGmailPage } = require('./agents/gmailSession');
    const page = await getGmailPage();

    const searchInput = page.locator('input[aria-label="Search mail"], input[name="q"]').first();
    await searchInput.click({ timeout: 8000 });
    await searchInput.fill(query);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2500);
    await page.waitForSelector('tr.zA, .TD', { timeout: 10000 }).catch(() => {});

    const emails = await page.$$eval('tr.zA', (rows) => {
      return rows.slice(0, 15).map((row, i) => {
        const senderEl = row.querySelector('.zF');
        const subjectEl = row.querySelector('.bog') || row.querySelector('.bqe');
        const previewEl = row.querySelector('.y2');
        const dateEl = row.querySelector('.xW span') || row.querySelector('.xW') || row.querySelector('.xS');
        return {
          index: i + 1,
          sender: senderEl?.getAttribute('name') || senderEl?.textContent?.trim() || '',
          subject: subjectEl?.textContent?.trim() || '',
          preview: previewEl?.textContent?.trim() || '',
          date: dateEl?.getAttribute('title') || dateEl?.textContent?.trim() || '',
        };
      });
    }).catch(() => []);

    return { query, results: emails, count: emails.length };
  } catch (err) {
    return { error: `gmail_search failed: ${err.message}` };
  }
}

async function gmailCompose({ to, subject, body }) {
  try {
    const { getGmailPage } = require('./agents/gmailSession');
    const page = await getGmailPage();

    // Click compose button
    await page.locator('[gh="cm"], .T-I.J-J5-Ji.T-I-KE.L3').first().click({ timeout: 8000 });
    await page.waitForTimeout(1000);

    // Fill To
    const toField = page.locator('textarea[name="to"], [aria-label="To recipients"]').first();
    await toField.fill(to, { timeout: 8000 });
    await page.keyboard.press('Tab');
    await page.waitForTimeout(300);

    // Fill Subject
    const subjectField = page.locator('input[name="subjectbox"]').first();
    await subjectField.fill(subject, { timeout: 8000 });
    await page.waitForTimeout(300);

    // Fill Body — click then type (fill doesn't work on contenteditable)
    const bodyField = page.locator('[aria-label="Message Body"]').first();
    await bodyField.click({ timeout: 8000 });
    await page.waitForTimeout(300);
    // Clear any existing content and type the body
    await page.keyboard.press('Control+a');
    await bodyField.type(body, { delay: 0 });
    await page.waitForTimeout(300);

    return { composed: true, to, subject, bodyLength: body.length };
  } catch (err) {
    return { error: `gmail_compose failed: ${err.message}` };
  }
}

async function gmailSend({ to, subject, body_preview }) {
  try {
    const { getGmailPage } = require('./agents/gmailSession');
    const page = await getGmailPage();

    // Click the Send button in the compose window
    const sendBtn = page.locator(
      '[data-tooltip^="Send"], [aria-label^="Send "], .T-I.J-J5-Ji.aoO.v7.T-I-atl.L3'
    ).first();
    await sendBtn.click({ timeout: 8000 });
    await page.waitForTimeout(1500);

    return { sent: true, to, subject };
  } catch (err) {
    return { error: `gmail_send failed: ${err.message}` };
  }
}

async function gmailCreateDraft() {
  try {
    const { getGmailPage } = require('./agents/gmailSession');
    const page = await getGmailPage();

    // Press Escape to minimize compose — Gmail auto-saves as draft
    await page.keyboard.press('Escape');
    await page.waitForTimeout(800);

    return { draft_saved: true };
  } catch (err) {
    return { error: `gmail_create_draft failed: ${err.message}` };
  }
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

async function executeTool(name, input) {
  switch (name) {
    case 'search_files':
      return searchFiles(input);
    case 'read_file':
      return readFile(input);
    case 'read_excel':
      return readExcel(input);
    case 'save_memory':
      return saveMemory(input);
    case 'search_memory':
      return searchMemory(input);
    case 'get_recent_conversations':
      return getRecentConversations(input);
    case 'search_emails':
      return searchEmails(input);
    case 'read_calendar':
      return readCalendar(input);
    case 'create_file':
      return createFile(input);
    case 'append_to_file':
      return appendToFile(input);
    case 'delete_file':
      return deleteFile(input);
    case 'open_file_or_folder':
      return openFileOrFolder(input);
    case 'create_word_file':
      return createWordFile(input);
    case 'create_excel_file':
      return createExcelFile(input);
    case 'create_pdf_file':
      return createPdfFile(input);
    case 'create_powerpoint_file':
      return createPowerpointFile(input);
    case 'fetch_webpage':
      return fetchWebpage(input);
    case 'browser_open':
      return browserOpen(input);
    case 'browser_click':
      return browserClick(input);
    case 'browser_type':
      return browserType(input);
    case 'browser_scroll':
      return browserScroll(input);
    case 'browser_screenshot':
      return browserScreenshot(input);
    case 'browser_extract':
      return browserExtract(input);
    case 'browser_close':
      return browserClose(input);
    case 'gmail_open_inbox':
      return gmailOpenInbox(input);
    case 'gmail_read_emails':
      return gmailReadEmails(input);
    case 'gmail_read_email':
      return gmailReadEmail(input);
    case 'gmail_search':
      return gmailSearch(input);
    case 'gmail_compose':
      return gmailCompose(input);
    case 'gmail_send':
      return gmailSend(input);
    case 'gmail_create_draft':
      return gmailCreateDraft(input);
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

module.exports = { TOOL_DEFINITIONS, executeTool, getRealDesktopPath };
