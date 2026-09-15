// AI Advisor — LLM agent loop + tool executor

import { store } from './store.js';
import { db } from './db.js';
import { saveSettings } from './settings.js';
import { pushCreate as pushGoogleCreate, pushDelete as pushGoogleDelete } from './google-calendar.js';

// Session-local API history (full provider-format messages including tool call/result pairs)
let _apiHistory = [];

// Conversation persistence
const CONV_KEY = 'notely-advisor-history';
let _currentConvId = null;

function loadAllConvs() {
  try { return JSON.parse(localStorage.getItem(CONV_KEY) || '[]'); } catch { return []; }
}

export function saveCurrentConversation() {
  const msgs = store.advisorMessages.filter(m => !m.working);
  if (!msgs.length) return;
  const convs = loadAllConvs();
  const maxN = store.settings?.advisor?.historyMax ?? 20;
  const title = (msgs.find(m => m.role === 'user')?.text || 'Conversation').slice(0, 60);
  const limited = msgs.slice(-100);
  if (_currentConvId) {
    const idx = convs.findIndex(c => c.id === _currentConvId);
    if (idx >= 0) {
      convs[idx] = { ...convs[idx], messages: limited, updatedAt: new Date().toISOString() };
      // Move to front so list stays newest-first
      convs.unshift(convs.splice(idx, 1)[0]);
    } else {
      convs.unshift({ id: _currentConvId, title, messages: limited, createdAt: new Date().toISOString() });
    }
  } else {
    _currentConvId = `conv_${Date.now()}`;
    convs.unshift({ id: _currentConvId, title, messages: limited, createdAt: new Date().toISOString() });
  }
  if (convs.length > maxN) convs.length = maxN;
  try { localStorage.setItem(CONV_KEY, JSON.stringify(convs)); } catch {}
}

export function loadConversation(conv) {
  _currentConvId = conv.id;
  _apiHistory = [];
  _sessionProvider = null;
  store.advisorMessages = [...conv.messages];
}

export function startNewConversation() {
  saveCurrentConversation();
  _currentConvId = null;
  _apiHistory = [];
  _sessionProvider = null;
  store.advisorMessages = [];
}

export function getAllConversations() {
  return loadAllConvs();
}

export function getCurrentConvId() {
  return _currentConvId;
}

export function clearAdvisorHistory() {
  startNewConversation();
}

// ── Tool definitions (Anthropic input_schema format) ─────────────

const TOOLS = [
  {
    name: 'list_task_lists',
    description: 'List all task lists with their id, name, and type.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'list_tasks',
    description: 'List tasks. Optionally filter by list_id or completion status.',
    input_schema: {
      type: 'object',
      properties: {
        list_id:   { type: 'integer', description: 'Filter to one task list' },
        completed: { type: 'boolean', description: 'true = done, false = pending, omit = all' },
        limit:     { type: 'integer', description: 'Max results, default 30' }
      }
    }
  },
  {
    name: 'add_task',
    description: 'Add a new task to a task list.',
    input_schema: {
      type: 'object',
      required: ['text', 'list_id'],
      properties: {
        text:     { type: 'string' },
        list_id:  { type: 'integer' },
        quantity: { type: 'integer', description: 'For quantity-type lists, default 1' }
      }
    }
  },
  {
    name: 'complete_task',
    description: 'Mark a task as completed.',
    input_schema: {
      type: 'object',
      required: ['task_id'],
      properties: { task_id: { type: 'integer' } }
    }
  },
  {
    name: 'delete_task',
    description: 'Delete a task permanently.',
    input_schema: {
      type: 'object',
      required: ['task_id'],
      properties: { task_id: { type: 'integer' } }
    }
  },
  {
    name: 'add_task_list',
    description: 'Create a new task list.',
    input_schema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string' },
        type: { type: 'string', enum: ['basic', 'priority', 'quantity'], description: 'Default: basic' }
      }
    }
  },
  {
    name: 'list_notebooks',
    description: 'List all notebooks.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'add_notebook',
    description: 'Create a new notebook.',
    input_schema: {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } }
    }
  },
  {
    name: 'list_notes',
    description: 'List notes, optionally filtered by notebook or full-text search.',
    input_schema: {
      type: 'object',
      properties: {
        notebook_id: { type: 'integer' },
        search:      { type: 'string', description: 'Search in title and body' },
        limit:       { type: 'integer', description: 'Max results, default 10' }
      }
    }
  },
  {
    name: 'add_note',
    description: 'Create a new note.',
    input_schema: {
      type: 'object',
      required: ['title'],
      properties: {
        title:       { type: 'string' },
        body:        { type: 'string', description: 'Markdown content' },
        notebook_id: { type: 'integer' }
      }
    }
  },
  {
    name: 'list_events',
    description: 'List calendar events within a date range.',
    input_schema: {
      type: 'object',
      properties: {
        date_from: { type: 'string', description: 'YYYY-MM-DD, defaults to today' },
        date_to:   { type: 'string', description: 'YYYY-MM-DD, defaults to 30 days from today' }
      }
    }
  },
  {
    name: 'add_event',
    description: 'Add a calendar event.',
    input_schema: {
      type: 'object',
      required: ['title', 'date'],
      properties: {
        title: { type: 'string' },
        date:  { type: 'string', description: 'YYYY-MM-DD' },
        time:  { type: 'string', description: 'HH:MM (24-hour, optional)' }
      }
    }
  },
  {
    name: 'get_scratchpad',
    description: 'Read the current contents of the dashboard scratchpad.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'set_scratchpad',
    description: 'Replace the dashboard scratchpad contents.',
    input_schema: {
      type: 'object',
      required: ['content'],
      properties: { content: { type: 'string' } }
    }
  },
  {
    name: 'list_widgets',
    description: 'List widgets currently on the dashboard (instances only). Each entry has widget_id, position, and size. To discover all widgets that could be added — including task lists, notebooks, and notes by title — use list_available_widgets instead.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'list_available_widgets',
    description: 'List the full catalog of widgets that can be placed on the dashboard: fixed built-in widgets plus one entry per task list, notebook, and note. Each entry includes widget_id, title, type, and whether it is currently on the dashboard. Use this to find the widget_id for a specific task list ("Shopping List"), notebook, or note by name before calling add_widget or remove_widget.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'add_widget',
    description: 'Add a widget to the dashboard by widget_id. Call list_available_widgets first to find the correct widget_id — especially for task lists, notebooks, and notes which use dynamic ids like "tasklist-3".',
    input_schema: {
      type: 'object',
      required: ['widget_id'],
      properties: { widget_id: { type: 'string', description: 'From list_available_widgets. Fixed: calendar | events | scratchpad | recentNotes | advisor. Dynamic: tasklist-{id} | notebook-{id} | note-{id}' } }
    }
  },
  {
    name: 'remove_widget',
    description: 'Remove a widget from the dashboard by widget_id. Call list_available_widgets or list_widgets first to find the correct id.',
    input_schema: {
      type: 'object',
      required: ['widget_id'],
      properties: { widget_id: { type: 'string', description: 'From list_available_widgets or list_widgets. Same id format as add_widget.' } }
    }
  },
  {
    name: 'delete_task_list',
    description: 'Permanently delete a task list and all its tasks. Also removes the list\'s dashboard widget if present. Use list_task_lists to find the id first.',
    input_schema: {
      type: 'object',
      required: ['list_id'],
      properties: { list_id: { type: 'integer', description: 'id from list_task_lists' } }
    }
  },
  {
    name: 'delete_note',
    description: 'Permanently delete a note. Also removes the note\'s dashboard widget if present. Use list_notes to find the id first.',
    input_schema: {
      type: 'object',
      required: ['note_id'],
      properties: { note_id: { type: 'integer', description: 'id from list_notes' } }
    }
  },
  {
    name: 'delete_notebook',
    description: 'Permanently delete a notebook. Notes inside it are kept but unassigned. Also removes the notebook\'s dashboard widget if present. Use list_notebooks to find the id first.',
    input_schema: {
      type: 'object',
      required: ['notebook_id'],
      properties: { notebook_id: { type: 'integer', description: 'id from list_notebooks' } }
    }
  },
  {
    name: 'delete_event',
    description: 'Permanently delete a calendar event. Use list_events to find the id first.',
    input_schema: {
      type: 'object',
      required: ['event_id'],
      properties: { event_id: { type: 'integer', description: 'id from list_events' } }
    }
  }
];

// ── Tool executor ────────────────────────────────────────────────

export async function executeTool(name, input) {
  try {
    const pad = n => String(n).padStart(2, '0');
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${pad(today.getMonth()+1)}-${pad(today.getDate())}`;

    switch (name) {
      case 'list_task_lists':
        return { task_lists: await db.all('SELECT * FROM task_lists ORDER BY created_at ASC') };

      case 'list_tasks': {
        let sql = 'SELECT t.*, tl.name as list_name, tl.type as list_type FROM tasks t JOIN task_lists tl ON t.list_id = tl.id WHERE 1=1';
        const p = [];
        if (input.list_id   !== undefined) { sql += ' AND t.list_id = ?';   p.push(input.list_id); }
        if (input.completed !== undefined) { sql += ' AND t.completed = ?'; p.push(input.completed ? 1 : 0); }
        sql += ' ORDER BY t.completed ASC, t.priority DESC, t.created_at ASC LIMIT ?';
        p.push(input.limit || 30);
        return { tasks: await db.all(sql, p) };
      }

      case 'add_task': {
        const res = await db.run('INSERT INTO tasks (list_id, text, quantity) VALUES (?, ?, ?)',
          [input.list_id, input.text, input.quantity || 1]);
        const task = await db.get('SELECT * FROM tasks WHERE id = ?', [res.lastInsertId]);
        store.tasks.unshift(task);
        return { success: true, task };
      }

      case 'complete_task':
        await db.run('UPDATE tasks SET completed = 1 WHERE id = ?', [input.task_id]);
        { const t = store.tasks.find(t => t.id === input.task_id); if (t) t.completed = 1; }
        return { success: true };

      case 'delete_task':
        await db.run('DELETE FROM tasks WHERE id = ?', [input.task_id]);
        store.tasks = store.tasks.filter(t => t.id !== input.task_id);
        return { success: true };

      case 'add_task_list': {
        const res = await db.run("INSERT INTO task_lists (name, type) VALUES (?, ?)",
          [input.name, input.type || 'basic']);
        const list = await db.get('SELECT * FROM task_lists WHERE id = ?', [res.lastInsertId]);
        store.taskLists.push(list);
        return { success: true, task_list: list };
      }

      case 'delete_task_list': {
        await db.run('DELETE FROM tasks WHERE list_id = ?', [input.list_id]);
        await db.run('DELETE FROM task_lists WHERE id = ?', [input.list_id]);
        store.tasks = store.tasks.filter(t => t.list_id !== input.list_id);
        store.taskLists = store.taskLists.filter(l => l.id !== input.list_id);
        const widgetId = `tasklist-${input.list_id}`;
        if (store.settings.dashboard.layout.find(l => l.id === widgetId)) {
          store.settings.dashboard.layout = store.settings.dashboard.layout.filter(l => l.id !== widgetId);
          saveSettings(store.settings);
        }
        return { success: true };
      }

      case 'list_notebooks':
        return { notebooks: await db.all('SELECT id, name FROM notebooks ORDER BY name ASC') };

      case 'add_notebook': {
        const res = await db.run('INSERT INTO notebooks (name) VALUES (?)', [input.name]);
        const notebook = await db.get('SELECT id, name FROM notebooks WHERE id = ?', [res.lastInsertId]);
        store.notebooks.push(notebook);
        store.notebooks.sort((a, b) => a.name.localeCompare(b.name));
        return { success: true, notebook };
      }

      case 'list_notes': {
        let sql = `SELECT n.id, n.title, n.created_at, nb.name as notebook_name
                   FROM notes n LEFT JOIN notebooks nb ON n.notebook_id = nb.id WHERE 1=1`;
        const p = [];
        if (input.notebook_id) { sql += ' AND n.notebook_id = ?'; p.push(input.notebook_id); }
        if (input.search)      { sql += ' AND (n.title LIKE ? OR n.body LIKE ?)'; p.push(`%${input.search}%`, `%${input.search}%`); }
        sql += ' ORDER BY n.created_at DESC LIMIT ?';
        p.push(input.limit || 10);
        return { notes: await db.all(sql, p) };
      }

      case 'add_note': {
        const res = await db.run('INSERT INTO notes (title, body, notebook_id) VALUES (?, ?, ?)',
          [input.title, input.body || '', input.notebook_id || null]);
        const note = await db.get(
          'SELECT n.*, nb.name as notebook_name FROM notes n LEFT JOIN notebooks nb ON n.notebook_id = nb.id WHERE n.id = ?',
          [res.lastInsertId]);
        store.notes.unshift(note);
        return { success: true, note: { id: note.id, title: note.title } };
      }

      case 'list_events': {
        const from = input.date_from || todayStr;
        const d30 = new Date(today); d30.setDate(d30.getDate() + 30);
        const to = input.date_to || `${d30.getFullYear()}-${pad(d30.getMonth()+1)}-${pad(d30.getDate())}`;
        return { events: await db.all('SELECT * FROM events WHERE date >= ? AND date <= ? ORDER BY date, time ASC', [from, to]) };
      }

      case 'add_event': {
        const res = await db.run('INSERT INTO events (title, date, time) VALUES (?, ?, ?)',
          [input.title, input.date, input.time || null]);
        const ev = await db.get('SELECT * FROM events WHERE id = ?', [res.lastInsertId]);
        store.events.push(ev);
        store.events.sort((a, b) => a.date.localeCompare(b.date) || (a.time||'').localeCompare(b.time||''));
        pushGoogleCreate(ev);
        return { success: true, event: ev };
      }

      case 'delete_event': {
        const ev = await db.get('SELECT * FROM events WHERE id = ?', [input.event_id]);
        await db.run('DELETE FROM events WHERE id = ?', [input.event_id]);
        store.events = store.events.filter(e => e.id !== input.event_id);
        pushGoogleDelete(ev);
        return { success: true };
      }

      case 'delete_note': {
        await db.run('DELETE FROM notes WHERE id = ?', [input.note_id]);
        store.notes = store.notes.filter(n => n.id !== input.note_id);
        const noteWidgetId = `note-${input.note_id}`;
        if (store.settings.dashboard.layout.find(l => l.id === noteWidgetId)) {
          store.settings.dashboard.layout = store.settings.dashboard.layout.filter(l => l.id !== noteWidgetId);
          saveSettings(store.settings);
        }
        return { success: true };
      }

      case 'delete_notebook': {
        await db.run('UPDATE notes SET notebook_id = NULL WHERE notebook_id = ?', [input.notebook_id]);
        await db.run('DELETE FROM notebooks WHERE id = ?', [input.notebook_id]);
        store.notebooks = store.notebooks.filter(nb => nb.id !== input.notebook_id);
        store.notes.forEach(n => { if (n.notebook_id === input.notebook_id) n.notebook_id = null; });
        const nbWidgetId = `notebook-${input.notebook_id}`;
        if (store.settings.dashboard.layout.find(l => l.id === nbWidgetId)) {
          store.settings.dashboard.layout = store.settings.dashboard.layout.filter(l => l.id !== nbWidgetId);
          saveSettings(store.settings);
        }
        return { success: true };
      }

      case 'get_scratchpad':
        return { content: localStorage.getItem('notely-scratchpad') || '' };

      case 'set_scratchpad': {
        const val = input.content ?? '';
        localStorage.setItem('notely-scratchpad', val);
        const el = document.getElementById('scratchpad');
        if (el) el.value = val;
        return { success: true };
      }

      case 'list_widgets':
        return { widgets: store.settings.dashboard.layout.map(w => ({ widget_id: w.id, x: w.x, y: w.y, w: w.w, h: w.h })) };

      case 'list_available_widgets': {
        const onDashboard = new Set(store.settings.dashboard.layout.map(l => l.id));
        const fixed = [
          { widget_id: 'calendar',    type: 'fixed', title: 'Calendar' },
          { widget_id: 'events',      type: 'fixed', title: 'Events' },
          { widget_id: 'scratchpad',  type: 'fixed', title: 'Scratchpad' },
          { widget_id: 'recentNotes', type: 'fixed', title: 'Recent Notes' },
          { widget_id: 'advisor',     type: 'fixed', title: 'AI Advisor' },
        ];
        const taskLists = await db.all('SELECT id, name FROM task_lists ORDER BY created_at ASC');
        const notebooks = await db.all('SELECT id, name FROM notebooks ORDER BY name ASC');
        const notes     = await db.all('SELECT id, title FROM notes ORDER BY created_at DESC LIMIT 20');
        return {
          widgets: [
            ...fixed.map(w => ({ ...w, on_dashboard: onDashboard.has(w.widget_id) })),
            ...taskLists.map(l => ({ widget_id: `tasklist-${l.id}`,  type: 'task_list', title: l.name,  on_dashboard: onDashboard.has(`tasklist-${l.id}`) })),
            ...notebooks.map(n => ({ widget_id: `notebook-${n.id}`,  type: 'notebook',  title: n.name,  on_dashboard: onDashboard.has(`notebook-${n.id}`) })),
            ...notes.map(n =>     ({ widget_id: `note-${n.id}`,      type: 'note',      title: n.title, on_dashboard: onDashboard.has(`note-${n.id}`) })),
          ]
        };
      }

      case 'add_widget': {
        const layout = store.settings.dashboard.layout;
        if (layout.find(l => l.id === input.widget_id)) return { success: true, message: 'already on dashboard' };
        const size = input.widget_id.startsWith('note-') ? { w: 4, h: 4 } : { w: 4, h: 5 };
        layout.push({ id: input.widget_id, x: 0, y: 9999, ...size });
        saveSettings(store.settings);
        return { success: true };
      }

      case 'remove_widget':
        store.settings.dashboard.layout = store.settings.dashboard.layout.filter(l => l.id !== input.widget_id);
        saveSettings(store.settings);
        return { success: true };

      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: String(err) };
  }
}

// ── Provider resolution ──────────────────────────────────────────

let _sessionProvider = null; // tracks provider for current history

function resolveProvider(cfg) {
  const explicit = cfg.provider;
  if (explicit && explicit !== 'auto') return explicit;
  const key = cfg.apiKey || '';
  if (key.startsWith('sk-ant-')) return 'anthropic';
  if (key.startsWith('AIza'))    return 'gemini';
  if (key)                       return 'openai';
  return null;
}

// ── Tool format converters ───────────────────────────────────────

function toOpenAITools(tools) {
  return tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema }
  }));
}

function geminiSchema(s) {
  if (!s) return { type: 'OBJECT', properties: {} };
  const cvt = o => {
    const r = {};
    if (o.type)        r.type = o.type.toUpperCase();
    if (o.description) r.description = o.description;
    if (o.enum)        r.enum = o.enum;
    if (o.properties)  r.properties = Object.fromEntries(Object.entries(o.properties).map(([k,v]) => [k, cvt(v)]));
    if (o.required)    r.required = o.required;
    return r;
  };
  return cvt(s);
}

function toGeminiTools(tools) {
  return [{ function_declarations: tools.map(t => ({ name: t.name, description: t.description, parameters: geminiSchema(t.input_schema) })) }];
}

// ── API calls ────────────────────────────────────────────────────

async function callAnthropic(messages, systemPrompt, apiKey) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 4096, system: systemPrompt, messages, tools: TOOLS })
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error?.message || `Anthropic ${res.status}`); }
  return res.json();
}

async function callOpenAI(messages, systemPrompt, apiKey) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'system', content: systemPrompt }, ...messages], tools: toOpenAITools(TOOLS), tool_choice: 'auto' })
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error?.message || `OpenAI ${res.status}`); }
  return res.json();
}

async function callGemini(messages, systemPrompt, apiKey) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: messages,
        tools: toGeminiTools(TOOLS)
      })
    }
  );
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error?.message || `Gemini ${res.status}`); }
  return res.json();
}

// ── Parse provider responses ─────────────────────────────────────

function parseAnthropic(raw) {
  return {
    text: raw.content.filter(c => c.type === 'text').map(c => c.text).join(''),
    toolCalls: raw.content.filter(c => c.type === 'tool_use').map(c => ({ id: c.id, name: c.name, input: c.input })),
    hasTools: raw.stop_reason === 'tool_use',
    rawContent: raw.content
  };
}

function parseOpenAI(raw) {
  const msg = raw.choices[0].message;
  return {
    text: msg.content || '',
    toolCalls: (msg.tool_calls || []).map(tc => ({ id: tc.id, name: tc.function.name, input: JSON.parse(tc.function.arguments || '{}') })),
    hasTools: raw.choices[0].finish_reason === 'tool_calls',
    rawMsg: msg
  };
}

function parseGemini(raw) {
  const parts = raw.candidates?.[0]?.content?.parts || [];
  return {
    text: parts.filter(p => p.text).map(p => p.text).join(''),
    toolCalls: parts.filter(p => p.functionCall).map((p, i) => ({ id: `fc_${i}_${Date.now()}`, name: p.functionCall.name, input: p.functionCall.args || {} })),
    hasTools: parts.some(p => p.functionCall),
    rawParts: parts
  };
}

// ── Context window pruning ───────────────────────────────────────

// Returns a trimmed copy of history keeping only the last maxUserMsgs user turns
// (plus all their interleaved assistant/tool entries)
function pruneHistory(history, provider, maxUserMsgs) {
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    const isUserText = provider === 'gemini'
      ? (h.role === 'user' && h.parts?.some(p => p.text && !p.functionResponse))
      : (h.role === 'user' && typeof h.content === 'string');
    if (isUserText && ++count >= maxUserMsgs) return history.slice(i);
  }
  return history;
}

// ── Agent loop ───────────────────────────────────────────────────

export async function runAdvisor(userText, onUpdate) {
  const cfg = store.settings.advisor || {};
  if (!cfg.apiKey) throw new Error('No API key configured — go to Settings → AI Advisor to add one.');

  const provider = resolveProvider(cfg);
  if (!provider) throw new Error('Cannot determine provider. Check your API key or set Provider in Settings.');

  // Reset history if provider changed mid-session
  if (_sessionProvider && _sessionProvider !== provider) {
    _apiHistory = [];
    store.advisorMessages = store.advisorMessages.filter(m => !m._historyOnly);
  }
  _sessionProvider = provider;

  const today = new Date();
  const todayStr = today.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const name = cfg.name || 'AI Advisor';
  const userContext = (cfg.systemPrompt || '').trim();
  const systemPrompt = [
    `You are ${name}, a helpful personal assistant built into Notely — a personal productivity app.`,
    userContext ? `\nUser context:\n${userContext}` : '',
    `\nToday is ${todayStr}.`,
    `\nUse your tools to act on requests directly. Be concise.`
  ].join('');

  // Append user message to display + provider history
  store.advisorMessages.push({ role: 'user', text: userText });
  if (provider === 'gemini') {
    _apiHistory.push({ role: 'user', parts: [{ text: userText }] });
  } else {
    _apiHistory.push({ role: 'user', content: userText });
  }
  onUpdate();

  let iterations = 0;
  while (iterations++ < 10) {
    const ctx = pruneHistory(_apiHistory, provider, 10);
    const raw = provider === 'anthropic' ? await callAnthropic(ctx, systemPrompt, cfg.apiKey)
              : provider === 'gemini'    ? await callGemini(ctx, systemPrompt, cfg.apiKey)
              :                            await callOpenAI(ctx, systemPrompt, cfg.apiKey);

    const parsed = provider === 'anthropic' ? parseAnthropic(raw)
                 : provider === 'gemini'    ? parseGemini(raw)
                 :                            parseOpenAI(raw);

    if (parsed.hasTools && parsed.toolCalls.length > 0) {
      // Record assistant turn with tool calls in history
      if (provider === 'anthropic') {
        _apiHistory.push({ role: 'assistant', content: parsed.rawContent });
      } else if (provider === 'gemini') {
        // Use rawParts verbatim — Gemini requires thought signatures to be echoed back intact
        _apiHistory.push({ role: 'model', parts: parsed.rawParts });
      } else {
        _apiHistory.push({ role: 'assistant', content: parsed.text || null, tool_calls: parsed.rawMsg.tool_calls });
      }

      // Execute all tools, collect results
      const toolSummary = [];
      const anthropicResults = [];
      const geminiResults   = [];
      for (const call of parsed.toolCalls) {
        const result = await executeTool(call.name, call.input);
        toolSummary.push(call.name.replace(/_/g, ' '));
        if (provider === 'anthropic') {
          anthropicResults.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(result) });
        } else if (provider === 'gemini') {
          geminiResults.push({ functionResponse: { name: call.name, response: { content: JSON.stringify(result) } } });
        } else {
          _apiHistory.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
        }
      }
      // Batch results into one turn for Anthropic and Gemini
      if (anthropicResults.length) _apiHistory.push({ role: 'user', content: anthropicResults });
      if (geminiResults.length)    _apiHistory.push({ role: 'user', parts: geminiResults });

      const workingIdx = store.advisorMessages.push({ role: 'assistant', text: `_Using: ${toolSummary.join(', ')}…_`, working: true }) - 1;
      onUpdate();
      store.advisorMessages.splice(workingIdx, 1);

    } else {
      // Final text response
      if (provider === 'gemini') {
        _apiHistory.push({ role: 'model', parts: parsed.rawParts });
      } else {
        _apiHistory.push({ role: 'assistant', content: parsed.text });
      }
      store.advisorMessages.push({ role: 'assistant', text: parsed.text });
      saveCurrentConversation();
      onUpdate();
      break;
    }
  }
}
