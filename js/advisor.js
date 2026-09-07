// AI Advisor — LLM agent loop + tool executor

import { store } from './store.js';
import { db } from './db.js';

// Session-local API history (full provider-format messages including tool call/result pairs)
let _apiHistory = [];

export function clearAdvisorHistory() {
  _apiHistory = [];
  store.advisorMessages = [];
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
  }
];

function toOpenAITools(tools) {
  return tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema }
  }));
}

// ── Tool executor ────────────────────────────────────────────────

async function executeTool(name, input) {
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

      case 'list_notebooks':
        return { notebooks: await db.all('SELECT id, name FROM notebooks ORDER BY name ASC') };

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
        return { success: true, event: ev };
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: String(err) };
  }
}

// ── Provider detection ───────────────────────────────────────────

function detectProvider(key) {
  if (!key) return null;
  if (key.startsWith('sk-ant-')) return 'anthropic';
  return 'openai'; // sk-*, etc.
}

// ── API calls ────────────────────────────────────────────────────

async function callAnthropic(messages, systemPrompt, apiKey) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-client-side-api-key-usage': 'true'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      system: systemPrompt,
      messages,
      tools: TOOLS
    })
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error?.message || `Anthropic API error ${res.status}`);
  }
  return res.json();
}

async function callOpenAI(messages, systemPrompt, apiKey) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      tools: toOpenAITools(TOOLS),
      tool_choice: 'auto'
    })
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error?.message || `OpenAI API error ${res.status}`);
  }
  return res.json();
}

// ── Agent loop ───────────────────────────────────────────────────

export async function runAdvisor(userText, onUpdate) {
  const cfg = store.settings.advisor || {};
  const apiKey = cfg.apiKey;
  if (!apiKey) throw new Error('No API key configured — go to Settings → AI Advisor to add one.');

  const provider = detectProvider(apiKey);
  if (!provider) throw new Error('Cannot detect provider from API key prefix.');

  const pad = n => String(n).padStart(2, '0');
  const today = new Date();
  const todayStr = today.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const name = cfg.name || 'AI Advisor';
  const userContext = (cfg.systemPrompt || '').trim();

  const systemPrompt = [
    `You are ${name}, a helpful personal assistant built into Notely — a personal productivity app.`,
    userContext ? `\nUser context:\n${userContext}` : '',
    `\nToday is ${todayStr}.`,
    `\nYou have tools to manage the user's tasks, notes, and calendar. Use them to act on requests directly — don't just tell the user what to do. Be concise.`
  ].join('');

  // Append user turn to both display and API history
  store.advisorMessages.push({ role: 'user', text: userText });
  _apiHistory.push({ role: 'user', content: userText });
  onUpdate();

  let iterations = 0;
  while (iterations++ < 10) {
    let parsed;
    try {
      if (provider === 'anthropic') {
        const raw = await callAnthropic(_apiHistory, systemPrompt, apiKey);
        const text = raw.content.filter(c => c.type === 'text').map(c => c.text).join('');
        const toolCalls = raw.content.filter(c => c.type === 'tool_use').map(c => ({ id: c.id, name: c.name, input: c.input }));
        parsed = { text, toolCalls, stopped: raw.stop_reason !== 'tool_use', rawContent: raw.content };
      } else {
        const raw = await callOpenAI(_apiHistory, systemPrompt, apiKey);
        const msg = raw.choices[0].message;
        const text = msg.content || '';
        const toolCalls = (msg.tool_calls || []).map(tc => ({
          id: tc.id, name: tc.function.name,
          input: JSON.parse(tc.function.arguments || '{}')
        }));
        parsed = { text, toolCalls, stopped: raw.choices[0].finish_reason !== 'tool_calls', rawMsg: msg };
      }
    } catch (err) {
      throw err;
    }

    if (parsed.toolCalls.length > 0) {
      // Add assistant message with tool calls to API history
      if (provider === 'anthropic') {
        _apiHistory.push({ role: 'assistant', content: parsed.rawContent });
      } else {
        _apiHistory.push({ role: 'assistant', content: parsed.text || null, tool_calls: parsed.rawMsg.tool_calls });
      }

      // Execute tools and collect results
      const toolSummary = [];
      for (const call of parsed.toolCalls) {
        const result = await executeTool(call.name, call.input);
        toolSummary.push(call.name.replace(/_/g, ' '));
        if (provider === 'anthropic') {
          _apiHistory.push({
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(result) }]
          });
        } else {
          _apiHistory.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
        }
      }

      // Show a subtle "working" message while tools run
      const workingIdx = store.advisorMessages.push({ role: 'assistant', text: `_Using: ${toolSummary.join(', ')}…_`, working: true }) - 1;
      onUpdate();
      // Remove the working indicator before adding final response
      store.advisorMessages.splice(workingIdx, 1);

    } else {
      // Final text response
      _apiHistory.push({ role: 'assistant', content: parsed.text });
      store.advisorMessages.push({ role: 'assistant', text: parsed.text });
      onUpdate();
      break;
    }
  }
}
