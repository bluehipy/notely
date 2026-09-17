// Tool executor — backs the WebMCP surface (app.js) and the native-bridge/MCP
// server relay (background.js -> chrome.runtime.onMessage), letting an
// external MCP client (e.g. Claude Desktop) read and act on Notely's data.

import { store } from './store.js';
import { db } from './db.js';
import { saveSettings } from './settings.js';
import { fetchEvents, createEvent, deleteEvent, isActive as isGoogleSyncActive } from './google-calendar.js';

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
        if (!isGoogleSyncActive()) return { events: [], error: 'Google Calendar not connected' };
        const from = input.date_from || todayStr;
        const d30 = new Date(today); d30.setDate(d30.getDate() + 30);
        const to = input.date_to || `${d30.getFullYear()}-${pad(d30.getMonth()+1)}-${pad(d30.getDate())}`;
        const timeMin = new Date(`${from}T00:00:00`).toISOString();
        const timeMax = new Date(`${to}T23:59:59`).toISOString();
        return { events: await fetchEvents(timeMin, timeMax) };
      }

      case 'add_event': {
        const gcal = store.settings.googleCalendar;
        if (!isGoogleSyncActive() || !gcal.writeCalendarId) return { error: 'Google Calendar not connected' };
        const ev = await createEvent(gcal.writeCalendarId, {
          title: input.title, date: input.date, time: input.time || null, allDay: !input.time, endDate: input.date
        });
        store.events.push(ev);
        store.events.sort((a, b) => a.date.localeCompare(b.date) || (a.time||'').localeCompare(b.time||''));
        return { success: true, event: ev };
      }

      case 'delete_event': {
        const ev = store.events.find(e => e.id === input.event_id);
        if (!ev) return { error: 'Event not found — call list_events first' };
        await deleteEvent(ev.calendarId, ev.id, { scope: 'this', recurringEventId: ev.recurringEventId });
        store.events = store.events.filter(e => !(e.id === ev.id && e.calendarId === ev.calendarId));
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
