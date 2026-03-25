import { useState, useEffect, useRef } from 'react';

// Detect if text is predominantly Hebrew (RTL)
function isHebrew(text) {
  const hebrewChars = (text.match(/[\u0590-\u05FF]/g) || []).length;
  return hebrewChars > text.length * 0.2;
}

const TOOL_LABELS = {
  search_files: '🔍 Searching files',
  read_file: '📄 Reading file',
  read_excel: '📊 Reading Excel',
  search_emails: '📧 Searching emails',
  read_calendar: '📅 Reading calendar',
  fetch_webpage: '🌐 Fetching webpage',
  save_memory: '🧠 Saving to memory',
  search_memory: '🧠 Searching memory',
  get_recent_conversations: '🧠 Retrieving conversations',
  create_file: '📝 Creating file',
  append_to_file: '📝 Appending to file',
  delete_file: '🗑️ Deleting file',
  open_file_or_folder: '📂 Opening',
  create_word_file: '📝 Creating Word document',
  create_excel_file: '📊 Creating Excel spreadsheet',
  create_pdf_file: '📄 Creating PDF',
  create_powerpoint_file: '📊 Creating PowerPoint presentation',
  browser_open:       '🌐 Opening browser',
  browser_click:      '🖱️ Clicking',
  browser_type:       '⌨️ Typing',
  browser_scroll:     '📜 Scrolling',
  browser_screenshot: '📸 Screenshot',
  browser_extract:    '📋 Extracting content',
  browser_close:      '🌐 Closing browser',
  gmail_open_inbox:   '📬 Opening Gmail inbox',
  gmail_read_emails:  '📧 Reading emails',
  gmail_read_email:   '📧 Reading email',
  gmail_search:       '🔍 Searching Gmail',
  gmail_compose:      '✍️ Composing email',
  gmail_send:         '📤 Sending email',
  gmail_create_draft: '📝 Saving draft',
};

const AGENT_COLORS = {
  FileAgent:     'text-sky-400',
  WebAgent:      'text-emerald-400',
  MemoryAgent:   'text-violet-400',
  OutlookAgent:  'text-amber-400',
  BrowserAgent:  'text-cyan-400',
  GmailAgent:    'text-red-400',
  Orchestrator:  'text-indigo-400',
};

function AgentTag({ agent }) {
  if (!agent || agent === 'Orchestrator') return null;
  const color = AGENT_COLORS[agent] || 'text-slate-400';
  return <span className={`font-semibold ${color}`}>[{agent}]</span>;
}

function ToolCallBadge({ step }) {
  return (
    <div className="flex items-center gap-2 text-xs text-slate-400 bg-slate-800 rounded px-3 py-1.5 w-fit">
      <AgentTag agent={step.agent} />
      <span>{TOOL_LABELS[step.tool] || `🔧 ${step.tool}`}</span>
      {step.input && (
        <span className="text-slate-500 truncate max-w-xs">
          {JSON.stringify(step.input).slice(0, 80)}
        </span>
      )}
    </div>
  );
}

function BrowserScreenshotCard({ step }) {
  return (
    <div className="flex flex-col gap-1 mt-1 w-fit max-w-[85%]">
      <div className="flex items-center gap-2 text-xs text-cyan-400">
        <span>📸</span>
        <span className="text-slate-500 truncate">{step.title || step.url || 'Screenshot'}</span>
      </div>
      <img
        src={`data:image/png;base64,${step.screenshot}`}
        alt="Browser screenshot"
        className="rounded-lg border border-slate-700 max-w-full max-h-72 object-contain"
      />
    </div>
  );
}

function AgentHandoffBadge({ step }) {
  const color = AGENT_COLORS[step.agent] || 'text-slate-400';
  return (
    <div className="flex items-center gap-2 text-xs text-slate-400 bg-slate-800/60 border border-slate-700 rounded px-3 py-1.5 w-fit">
      <span className={`font-semibold ${color}`}>→ {step.agent}</span>
      {step.task && (
        <span className="text-slate-500 truncate max-w-xs">{step.task.slice(0, 80)}</span>
      )}
    </div>
  );
}

function ConfirmationCard({ step, onConfirm }) {
  const { tool, input } = step;
  const isDelete = tool === 'delete_file';
  const isBrowser = tool === 'browser_open' || tool === 'browser_click' || tool === 'browser_type';
  const isGmailSend = tool === 'gmail_send';

  const titles = {
    create_file: input.overwrite ? '⚠️ Overwrite existing file?' : '📝 Create file?',
    append_to_file: '📝 Append to file?',
    delete_file: '🗑️ Move file to Recycle Bin?',
    create_word_file: '📝 Create Word document?',
    create_excel_file: '📊 Create Excel spreadsheet?',
    create_pdf_file: '📄 Create PDF?',
    create_powerpoint_file: '📊 Create PowerPoint presentation?',
    browser_open:  '🌐 Open URL in browser?',
    browser_click: '🖱️ Click element?',
    browser_type:  '⌨️ Type into field?',
    gmail_send:    '📤 Send this email?',
  };

  const borderColor = isDelete || isGmailSend ? 'border-red-700' : isBrowser ? 'border-cyan-700' : 'border-amber-700';
  const headerColor = isDelete || isGmailSend ? 'text-red-400' : isBrowser ? 'text-cyan-400' : 'text-amber-400';
  const approveClass = isDelete
    ? 'bg-red-700 hover:bg-red-600 text-white'
    : isGmailSend
    ? 'bg-red-600 hover:bg-red-500 text-white'
    : 'bg-green-700 hover:bg-green-600 text-white';
  const approveLabel = isDelete ? 'Delete' : isGmailSend ? 'Send' : 'Approve';

  return (
    <div className={`border ${borderColor} rounded-xl p-3 text-xs bg-slate-900 w-fit max-w-[85%] flex flex-col gap-2`}>
      <div className={`font-semibold ${headerColor}`}>{titles[tool] || `⚙️ ${tool}?`}</div>

      {/* File tools: show path */}
      {input.path && !isBrowser && !isGmailSend && (
        <div className="text-slate-300 font-mono break-all">{input.path}</div>
      )}

      {/* Browser tools: show URL / selector / text */}
      {tool === 'browser_open' && (
        <div className="text-slate-300 font-mono break-all">{input.url}</div>
      )}
      {tool === 'browser_click' && (
        <div className="flex flex-col gap-1">
          <div className="text-slate-400">{input.description}</div>
          <div className="text-slate-500 font-mono">{input.selector}</div>
        </div>
      )}
      {tool === 'browser_type' && (
        <div className="flex flex-col gap-1">
          <div className="text-slate-500 font-mono">{input.selector}</div>
          <div className="bg-slate-800 rounded p-2 text-slate-300 break-all">
            {String(input.text).slice(0, 200)}{String(input.text).length > 200 ? '…' : ''}
          </div>
        </div>
      )}

      {/* Gmail send: show full email preview */}
      {isGmailSend && (
        <div className="flex flex-col gap-1.5">
          <div className="flex gap-2">
            <span className="text-slate-500 w-14 shrink-0">To:</span>
            <span className="text-slate-200 break-all">{input.to}</span>
          </div>
          <div className="flex gap-2">
            <span className="text-slate-500 w-14 shrink-0">Subject:</span>
            <span className="text-slate-200">{input.subject}</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-slate-500">Body:</span>
            <div className="bg-slate-800 rounded p-2 text-slate-300 whitespace-pre-wrap max-h-36 overflow-y-auto leading-relaxed">
              {String(input.body_preview).slice(0, 500)}{String(input.body_preview).length > 500 ? '\n…' : ''}
            </div>
          </div>
        </div>
      )}

      {(tool === 'create_file' || tool === 'append_to_file') && input.content && (
        <div className="bg-slate-800 rounded p-2 text-slate-400 whitespace-pre-wrap max-h-28 overflow-y-auto">
          {input.content.slice(0, 400)}{input.content.length > 400 ? '\n…' : ''}
        </div>
      )}

      <div className="flex gap-2 mt-1">
        <button
          onClick={() => onConfirm(true)}
          className={`px-3 py-1 rounded-lg text-xs font-medium transition ${approveClass}`}
        >
          {approveLabel}
        </button>
        <button
          onClick={() => onConfirm(false)}
          className="px-3 py-1 rounded-lg text-xs font-medium bg-slate-700 hover:bg-slate-600 text-slate-200 transition"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function StepIndicator({ steps, onConfirm }) {
  if (!steps || steps.length === 0) return null;

  // Only the last confirm_required that hasn't been followed by a tool_result should be active
  const lastConfirmIdx = steps.reduce((found, s, i) => s.type === 'confirm_required' ? i : found, -1);
  const lastResultIdx = steps.reduce((found, s, i) => s.type === 'tool_result' ? i : found, -1);
  const activeConfirmIdx = lastConfirmIdx > lastResultIdx ? lastConfirmIdx : -1;

  return (
    <div className="flex flex-col gap-1 mt-1">
      {steps.map((step, i) => {
        if (step.type === 'thinking') {
          return (
            <div key={i} className="flex items-center gap-2 text-xs text-slate-500">
              <span className="animate-pulse">●</span> Thinking…
            </div>
          );
        }
        if (step.type === 'agent_handoff') {
          return <AgentHandoffBadge key={i} step={step} />;
        }
        if (step.type === 'browser_screenshot') {
          return <BrowserScreenshotCard key={i} step={step} />;
        }
        if (step.type === 'agent_return') {
          return null; // silent — the orchestrator's final answer covers it
        }
        if (step.type === 'tool_call') {
          return <ToolCallBadge key={i} step={step} />;
        }
        if (step.type === 'confirm_required') {
          if (i === activeConfirmIdx) {
            return <ConfirmationCard key={i} step={step} onConfirm={onConfirm} />;
          }
          // Already-resolved confirmation — show as a muted badge
          return (
            <div key={i} className="flex items-center gap-2 text-xs text-slate-500 bg-slate-800 rounded px-3 py-1.5 w-fit">
              <span>✓ {TOOL_LABELS[step.tool] || step.tool} confirmed</span>
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}

function Message({ msg, onConfirm }) {
  const rtl = isHebrew(msg.content);

  if (msg.role === 'user') {
    return (
      <div className="flex justify-end">
        <div
          dir={rtl ? 'rtl' : 'ltr'}
          className="max-w-[75%] bg-indigo-600 text-white rounded-2xl rounded-tr-sm px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap"
        >
          {msg.content}
        </div>
      </div>
    );
  }

  const rtlAnswer = isHebrew(msg.content);

  return (
    <div className="flex flex-col gap-1">
      <StepIndicator steps={msg.steps} onConfirm={onConfirm} />
      <div className="flex justify-start">
        <div
          dir={rtlAnswer ? 'rtl' : 'ltr'}
          className="max-w-[85%] bg-slate-800 text-slate-100 rounded-2xl rounded-tl-sm px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap"
        >
          {msg.content}
        </div>
      </div>
    </div>
  );
}

function ThinkingBubble({ steps, onConfirm }) {
  return (
    <div className="flex flex-col gap-1">
      <StepIndicator steps={steps} onConfirm={onConfirm} />
      {steps.length === 0 && (
        <div className="flex items-center gap-2 text-slate-500 text-xs">
          <span className="animate-pulse">●</span> Thinking…
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [liveSteps, setLiveSteps] = useState([]);
  const [pendingConfirm, setPendingConfirm] = useState(false);
  const bottomRef = useRef(null);
  const inputRef = useRef(null);
  const unsubRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, liveSteps, loading]);

  useEffect(() => {
    if (window.agent?.onStep) {
      unsubRef.current = window.agent.onStep((step) => {
        setLiveSteps((prev) => [...prev, step]);
        if (step.type === 'confirm_required') setPendingConfirm(true);
        if (step.type === 'tool_result' && pendingConfirmRef.current) setPendingConfirm(false);
      });
    }
    return () => {
      if (unsubRef.current) unsubRef.current();
    };
  }, []);

  // Keep a ref in sync so the onStep closure can read current pendingConfirm
  const pendingConfirmRef = useRef(false);
  useEffect(() => { pendingConfirmRef.current = pendingConfirm; }, [pendingConfirm]);

  const handleConfirm = async (approved) => {
    setPendingConfirm(false);
    await window.agent.confirm(approved);
  };

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || loading) return;

    const userMsg = { role: 'user', content: text };
    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
    setInput('');
    setLoading(true);
    setLiveSteps([]);

    const history = nextMessages
      .slice(0, -1)
      .map((m) => ({ role: m.role, content: m.content }));

    try {
      const res = await window.agent.run(text, history);
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: res.success ? res.result.text : `Error: ${res.error}`,
          steps: res.success ? res.result.steps : [],
        },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `Error: ${err.message}`, steps: [] },
      ]);
    } finally {
      setLoading(false);
      setPendingConfirm(false);
      setLiveSteps([]);
      inputRef.current?.focus();
    }
  };

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const rtlInput = isHebrew(input);
  const inputDisabled = loading || pendingConfirm;

  return (
    <div className="flex flex-col h-screen bg-slate-900 text-slate-100 font-sans">
      {/* Header */}
      <header className="flex items-center justify-between px-5 py-3 border-b border-slate-800 bg-slate-900/80 backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <span className="text-indigo-400 text-lg">⬡</span>
          <span className="font-semibold text-sm tracking-wide">Personal Agent</span>
        </div>
        <span className="text-xs text-slate-500">claude-sonnet-4-5</span>
      </header>

      {/* Messages */}
      <main className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-4">
        {messages.length === 0 && !loading && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-slate-600">
            <span className="text-4xl">⬡</span>
            <p className="text-sm">Ask me anything — in Hebrew or English.</p>
            <div className="grid grid-cols-2 gap-2 mt-2 text-xs max-w-sm w-full">
              {[
                'מצא לי קבצי PDF בתיקיית מסמכים',
                'What meetings do I have this week?',
                'Search emails about "project deadline"',
                'קרא לי את הקובץ README.md',
              ].map((hint) => (
                <button
                  key={hint}
                  onClick={() => setInput(hint)}
                  dir={isHebrew(hint) ? 'rtl' : 'ltr'}
                  className="bg-slate-800 hover:bg-slate-700 transition rounded-lg px-3 py-2 text-slate-400 hover:text-slate-200 text-left"
                >
                  {hint}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <Message key={i} msg={msg} onConfirm={handleConfirm} />
        ))}

        {loading && <ThinkingBubble steps={liveSteps} onConfirm={handleConfirm} />}

        <div ref={bottomRef} />
      </main>

      {/* Input */}
      <footer className="border-t border-slate-800 px-4 py-3 bg-slate-900">
        <div className="flex gap-2 items-end max-w-3xl mx-auto">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKey}
            dir={rtlInput ? 'rtl' : 'ltr'}
            placeholder={pendingConfirm ? 'Waiting for your confirmation above…' : 'Ask anything… / שאל אותי משהו…'}
            rows={1}
            disabled={inputDisabled}
            className="flex-1 resize-none bg-slate-800 text-slate-100 placeholder-slate-500 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50 leading-relaxed"
            style={{ minHeight: '42px', maxHeight: '160px' }}
            onInput={(e) => {
              e.target.style.height = 'auto';
              e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px';
            }}
          />
          <button
            onClick={sendMessage}
            disabled={inputDisabled || !input.trim()}
            className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed transition rounded-xl px-4 py-2.5 text-sm font-medium flex-shrink-0"
          >
            {loading ? '…' : '↑'}
          </button>
        </div>
        <p className="text-center text-xs text-slate-700 mt-1.5">
          Enter to send · Shift+Enter for new line
        </p>
      </footer>
    </div>
  );
}
