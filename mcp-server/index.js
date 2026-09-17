#!/usr/bin/env node
// Notely MCP Server
// Runs as stdio MCP server for Claude Desktop.
// Connects to the native bridge (bridge.py) as a TCP CLIENT on 127.0.0.1:3779.
// The bridge owns the TCP server — multiple MCP processes can connect without conflict.
//
// Protocol (TCP):
//   MCP → bridge: {"id":"1","name":"list_tasks","input":{}} + \n
//   Bridge → MCP: {"id":"1","result":{...}} + \n

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import net from 'node:net';

const PORT = 3779;
const TOOL_TIMEOUT_MS = 15_000;

// ── Tool definitions ──────────────────────────────────────────────

const TOOLS = [
  {
    name: 'list_task_lists',
    description: 'List all task lists with their id, name, and type.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'list_tasks',
    description: 'List tasks. Optionally filter by list_id or completion status.',
    inputSchema: {
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
    inputSchema: {
      type: 'object',
      required: ['list_id'],
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
    inputSchema: {
      type: 'object',
      required: ['task_id'],
      properties: { task_id: { type: 'integer' } }
    }
  },
  {
    name: 'delete_task',
    description: 'Delete a task permanently.',
    inputSchema: {
      type: 'object',
      required: ['task_id'],
      properties: { task_id: { type: 'integer' } }
    }
  },
  {
    name: 'add_task_list',
    description: 'Create a new task list.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        type: { type: 'string', enum: ['basic', 'priority', 'quantity'], description: 'Default: basic' }
      }
    }
  },
  {
    name: 'list_notebooks',
    description: 'List all notebooks.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'add_notebook',
    description: 'Create a new notebook.',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } }
    }
  },
  {
    name: 'list_notes',
    description: 'List notes, optionally filtered by notebook or full-text search.',
    inputSchema: {
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
    inputSchema: {
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
    inputSchema: {
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
    inputSchema: {
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
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'set_scratchpad',
    description: 'Replace the dashboard scratchpad contents.',
    inputSchema: {
      type: 'object',
      required: ['content'],
      properties: { content: { type: 'string' } }
    }
  },
  {
    name: 'list_widgets',
    description: 'List widgets currently on the dashboard (instances only — what is placed right now). To discover all widgets that could be added, including task lists and notebooks by title, use list_available_widgets instead.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'list_available_widgets',
    description: 'List the full catalog of widgets that can be placed on the dashboard: fixed built-in widgets plus one entry per task list, notebook, and note. Each entry has widget_id, title, type, and on_dashboard (true/false). Use this to find the widget_id for a specific task list ("Shopping List"), notebook, or note by name before calling add_widget or remove_widget.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'add_widget',
    description: 'Add a widget to the dashboard by widget_id. Call list_available_widgets first to find the correct widget_id — especially for task lists, notebooks, and notes which use dynamic ids like "tasklist-3".',
    inputSchema: {
      type: 'object',
      required: ['widget_id'],
      properties: { widget_id: { type: 'string', description: 'From list_available_widgets. Fixed: calendar | events | scratchpad | recentNotes. Dynamic: tasklist-{id} | notebook-{id} | note-{id}' } }
    }
  },
  {
    name: 'remove_widget',
    description: 'Remove a widget from the dashboard by widget_id. Call list_available_widgets or list_widgets first to find the correct id.',
    inputSchema: {
      type: 'object',
      required: ['widget_id'],
      properties: { widget_id: { type: 'string', description: 'From list_available_widgets or list_widgets. Same id format as add_widget.' } }
    }
  },
  {
    name: 'delete_task_list',
    description: 'Permanently delete a task list and all its tasks. Also removes the list\'s dashboard widget if present. Use list_task_lists to find the id first.',
    inputSchema: {
      type: 'object',
      required: ['list_id'],
      properties: { list_id: { type: 'integer', description: 'id from list_task_lists' } }
    }
  },
  {
    name: 'delete_note',
    description: 'Permanently delete a note. Also removes the note\'s dashboard widget if present. Use list_notes to find the id first.',
    inputSchema: {
      type: 'object',
      required: ['note_id'],
      properties: { note_id: { type: 'integer', description: 'id from list_notes' } }
    }
  },
  {
    name: 'delete_notebook',
    description: 'Permanently delete a notebook. Notes inside it are kept but unassigned (notebook_id set to null). Also removes the notebook\'s dashboard widget if present. Use list_notebooks to find the id first.',
    inputSchema: {
      type: 'object',
      required: ['notebook_id'],
      properties: { notebook_id: { type: 'integer', description: 'id from list_notebooks' } }
    }
  },
  {
    name: 'delete_event',
    description: 'Permanently delete a calendar event. Use list_events to find the id first.',
    inputSchema: {
      type: 'object',
      required: ['event_id'],
      properties: { event_id: { type: 'string', description: 'id from list_events (a Google Calendar event id)' } }
    }
  }
];

// ── TCP connection to bridge ──────────────────────────────────────
// bridge.py owns the TCP server; we connect to it as a client and reconnect
// automatically if the bridge restarts.

const pending = new Map();
let callCounter = 0;
let bridgeSocket = null;

function connectToBridge() {
  const sock = net.createConnection(PORT, '127.0.0.1');
  let buf = '';

  sock.on('connect', () => {
    bridgeSocket = sock;
    console.error('[notely-mcp] Connected to bridge');
  });

  sock.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const { id, result } = JSON.parse(line);
        const entry = pending.get(String(id));
        if (entry) {
          clearTimeout(entry.timer);
          pending.delete(String(id));
          entry.resolve(result);
        }
      } catch {}
    }
  });

  sock.on('close', () => {
    if (bridgeSocket === sock) bridgeSocket = null;
    console.error('[notely-mcp] Bridge disconnected — retrying in 1 s');
    setTimeout(connectToBridge, 1000);
  });

  sock.on('error', () => {
    // 'close' fires after 'error', retry happens there
  });
}

connectToBridge();

function enqueueCall(name, input) {
  return new Promise((resolve, reject) => {
    const id = String(++callCounter);
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Notely bridge did not respond within 15 s. Is Notely open in Chrome?'));
    }, TOOL_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });

    if (bridgeSocket && !bridgeSocket.destroyed) {
      bridgeSocket.write(JSON.stringify({ id, name, input }) + '\n');
    }
  });
}

// ── MCP server ───────────────────────────────────────────────────

const server = new Server(
  { name: 'notely', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: input = {} } = request.params;
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) {
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }

  let result;
  try {
    result = await enqueueCall(name, input);
  } catch (err) {
    return { content: [{ type: 'text', text: String(err.message) }], isError: true };
  }

  const text = result && result.error
    ? `Error: ${result.error}`
    : JSON.stringify(result, null, 2);

  return { content: [{ type: 'text', text }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[notely-mcp] MCP server connected via stdio');
