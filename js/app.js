// Main application entry point - Notely

import { db, waitForReady } from './db.js';
import { store } from './store.js';
import { renderSidebar, renderNoteList, renderEditor, renderDashboard, renderTasksView, renderCalendarView, renderSettingsView, showNotePanels, showConfirmDialog, showToast } from './render.js';
import { saveSettings } from './settings.js';
import { initTheme, toggleTheme } from './theme.js';
import { initEditor, refreshAttachmentTray } from './editor.js';
import { initShortcuts } from './shortcuts.js';

// Search state
let searchDebounceTimer = null;
let currentSearchQuery = null;

// (gridstack handles all dashboard drag/resize)
let previousContext = {
  notebook: null,
  tag: null
};

// --- Routing ---

function setRoute(hash) {
  history.pushState(null, '', '#' + hash);
}

function parseRoute() {
  const hash = location.hash.slice(1);
  if (!hash || hash === 'all') return { view: 'all' };
  if (hash === 'dashboard') return { view: 'dashboard' };
  if (hash === 'tasks')     return { view: 'tasks' };
  if (hash === 'calendar')  return { view: 'calendar' };
  if (hash === 'settings')  return { view: 'settings' };
  const [section, id] = hash.split('/');
  if (section === 'notebook' && id) return { view: 'notebook', id: parseInt(id) };
  if (section === 'tag'      && id) return { view: 'tag',      id: parseInt(id) };
  if (section === 'note'     && id) return { view: 'note',     id: parseInt(id) };
  return { view: 'all' };
}

async function applyRoute() {
  const route = parseRoute();

  if (route.view === 'dashboard') {
    store.currentView = 'dashboard';
    store.currentNotebook = null;
    store.currentTag = null;
    store.currentNote = null;
    store.notes = await db.all(
      `SELECT n.*, nb.name as notebook_name
       FROM notes n LEFT JOIN notebooks nb ON n.notebook_id = nb.id
       ORDER BY n.created_at DESC LIMIT 50`
    );
    renderSidebar();
    renderDashboard();

  } else if (route.view === 'tasks') {
    store.currentView = 'tasks';
    store.currentNotebook = null;
    store.currentTag = null;
    store.currentNote = null;
    renderSidebar();
    renderTasksView();

  } else if (route.view === 'calendar') {
    store.currentView = 'calendar';
    store.currentNotebook = null;
    store.currentTag = null;
    store.currentNote = null;
    renderSidebar();
    renderCalendarView();

  } else if (route.view === 'settings') {
    store.currentView = 'settings';
    store.currentNotebook = null;
    store.currentTag = null;
    store.currentNote = null;
    renderSidebar();
    renderSettingsView();

  } else if (route.view === 'notebook') {
    store.currentView = 'notes';
    store.currentNotebook = route.id;
    store.currentTag = null;
    store.currentNote = null;
    showNotePanels();
    store.notes = await db.all(
      'SELECT * FROM notes WHERE notebook_id = ? ORDER BY updated_at DESC', [route.id]
    );
    renderSidebar(); renderNoteList(); await renderEditor(null);

  } else if (route.view === 'tag') {
    store.currentView = 'notes';
    store.currentNotebook = null;
    store.currentTag = route.id;
    store.currentNote = null;
    showNotePanels();
    store.notes = await db.all(
      `SELECT n.* FROM notes n JOIN note_tags nt ON n.id = nt.note_id
       WHERE nt.tag_id = ? ORDER BY n.updated_at DESC`, [route.id]
    );
    renderSidebar(); renderNoteList(); await renderEditor(null);

  } else if (route.view === 'note') {
    store.currentView = 'notes';
    store.currentNotebook = null;
    store.currentTag = null;
    store.currentNote = route.id;
    showNotePanels();
    store.notes = await db.all('SELECT * FROM notes ORDER BY updated_at DESC');
    const note = await db.get('SELECT * FROM notes WHERE id = ?', [route.id]);
    renderSidebar(); renderNoteList();
    await renderEditor(note || null);
    if (note) { initEditor(); await refreshAttachmentTray(); }

  } else {
    store.currentView = 'notes';
    store.currentNotebook = null;
    store.currentTag = null;
    store.currentNote = null;
    showNotePanels();
    store.notes = await db.all('SELECT * FROM notes ORDER BY updated_at DESC');
    renderSidebar(); renderNoteList(); await renderEditor(null);
  }
}

// Initialize app on DOM ready
document.addEventListener('DOMContentLoaded', async () => {
  console.log('Notely starting...');

  // Initialize theme (light/dark mode)
  initTheme();

  // Wait for database worker to be ready
  try {
    await waitForReady();
    console.log('Database ready');
  } catch (error) {
    console.error('Failed to initialize database:', error);
    return;
  }

  // Fetch initial data from database
  try {
    // Fetch notebooks
    store.notebooks = await db.all('SELECT * FROM notebooks ORDER BY name');
    console.log('Notebooks loaded:', store.notebooks.length);

    // Fetch all notes (sorted by updated_at DESC)
    store.notes = await db.all('SELECT * FROM notes ORDER BY updated_at DESC');
    console.log('Notes loaded:', store.notes.length);

    // Fetch tasks
    store.tasks = await db.all('SELECT * FROM tasks ORDER BY completed ASC, priority DESC, created_at ASC');

    // Fetch events
    store.events = await db.all('SELECT * FROM events ORDER BY date ASC, time ASC, id ASC');
    console.log('Tasks loaded:', store.tasks.length);

    // Fetch tags with counts
    store.tags = await db.all(`
      SELECT t.*, COUNT(nt.note_id) as count
      FROM tags t
      LEFT JOIN note_tags nt ON t.id = nt.tag_id
      GROUP BY t.id
      ORDER BY t.name
    `);
    console.log('Tags loaded:', store.tags.length);

  } catch (error) {
    console.error('Failed to load data:', error);
    return;
  }

  // Restore route from URL hash (or default to all-notes view)
  await applyRoute();

  // Initialize Lucide icons
  if (window.lucide) {
    window.lucide.createIcons();
  }

  // Set up event delegation
  setupEventListeners();

  // Initialize keyboard shortcuts
  initShortcuts(createNote);

  console.log('Notely ready');
});

// Event Listeners
function setupEventListeners() {
  // Sidebar event delegation
  document.getElementById('sidebar')?.addEventListener('click', handleSidebarClick);

  // Note list event delegation
  document.getElementById('note-list')?.addEventListener('click', handleNoteListClick);

  // Editor event delegation (for delete button)
  document.getElementById('editor')?.addEventListener('click', handleEditorClick);

  // Dashboard event delegation
  const dash = document.getElementById('dashboard');
  if (dash) {
    dash.addEventListener('click',   handleDashboardClick);
    dash.addEventListener('keydown', handleDashboardKeydown);
  }

  // Tasks view event delegation (same handlers — rerenderActiveView picks the right renderer)
  document.getElementById('tasks-view')?.addEventListener('click', handleDashboardClick);
  document.getElementById('tasks-view')?.addEventListener('keydown', handleDashboardKeydown);

  // Calendar view event delegation
  document.getElementById('calendar-view')?.addEventListener('click', handleDashboardClick);
  document.getElementById('calendar-view')?.addEventListener('keydown', handleDashboardKeydown);

  // Header contextual slot (add-widget menu when on dashboard)
  document.getElementById('header-contextual')?.addEventListener('click', handleDashboardClick);

  // Settings view event delegation
  document.getElementById('settings-view')?.addEventListener('change', handleSettingsChange);
  document.getElementById('settings-view')?.addEventListener('input', handleSettingsInput);

  // Hash-based routing (back/forward navigation)
  window.addEventListener('hashchange', applyRoute);

  // Theme toggle
  document.querySelector('.theme-toggle')?.addEventListener('click', handleThemeToggle);

  // Search input
  const searchInput = document.querySelector('.search-input');
  if (searchInput) {
    searchInput.addEventListener('input', (event) => {
      const query = event.target.value;

      // Debounce search (300ms)
      if (searchDebounceTimer) {
        clearTimeout(searchDebounceTimer);
      }

      searchDebounceTimer = setTimeout(() => {
        handleSearch(query);
      }, 300);
    });
  }
}

// Handle sidebar clicks
async function handleSidebarClick(event) {
  const target = event.target.closest('[data-action]');
  if (!target) return;

  const action = target.dataset.action;

  // Handle delete notebook separately (prevent propagation)
  if (action === 'delete-notebook') {
    event.stopPropagation();
    const notebookId = parseInt(target.dataset.id);
    await deleteNotebook(notebookId);
    return;
  }

  if (action === 'delete-tag') {
    event.stopPropagation();
    await deleteTag(parseInt(target.dataset.id));
    return;
  }

  if (action === 'rename-notebook') {
    event.stopPropagation();
    store.renamingNotebookId = parseInt(target.dataset.id);
    renderSidebar();
    return;
  }

  if (action === 'select-dashboard') {
    setRoute('dashboard');
    store.currentView = 'dashboard';
    store.currentNotebook = null;
    store.currentTag = null;
    store.currentNote = null;

    store.notes = await db.all(
      `SELECT n.*, nb.name as notebook_name
       FROM notes n
       LEFT JOIN notebooks nb ON n.notebook_id = nb.id
       ORDER BY n.created_at DESC
       LIMIT 50`
    );

    renderSidebar();
    renderDashboard();

  } else if (action === 'select-tasks') {
    setRoute('tasks');
    store.currentView = 'tasks';
    store.currentNotebook = null;
    store.currentTag = null;
    store.currentNote = null;
    renderSidebar();
    renderTasksView();

  } else if (action === 'select-calendar') {
    setRoute('calendar');
    store.currentView = 'calendar';
    store.currentNotebook = null;
    store.currentTag = null;
    store.currentNote = null;
    renderSidebar();
    renderCalendarView();

  } else if (action === 'select-settings') {
    setRoute('settings');
    store.currentView = 'settings';
    store.currentNotebook = null;
    store.currentTag = null;
    store.currentNote = null;
    renderSidebar();
    renderSettingsView();

  } else if (action === 'select-all-notes') {
    setRoute('all');
    store.currentView = 'notes';
    store.currentNotebook = null;
    store.currentTag = null;
    store.currentNote = null;

    showNotePanels();
    store.notes = await db.all('SELECT * FROM notes ORDER BY updated_at DESC');

    renderSidebar();
    renderNoteList();
    await renderEditor(null);

  } else if (action === 'select-notebook') {
    const notebookId = parseInt(target.dataset.id);
    setRoute('notebook/' + notebookId);
    store.currentView = 'notes';
    showNotePanels();
    store.currentNotebook = notebookId;
    store.currentTag = null;
    store.currentNote = null;

    store.notes = await db.all(
      'SELECT * FROM notes WHERE notebook_id = ? ORDER BY updated_at DESC',
      [notebookId]
    );

    renderSidebar();
    renderNoteList();
    await renderEditor(null);

  } else if (action === 'select-tag') {
    const tagId = parseInt(target.dataset.id);
    setRoute('tag/' + tagId);
    store.currentView = 'notes';
    showNotePanels();
    store.currentNotebook = null;
    store.currentTag = tagId;
    store.currentNote = null;

    store.notes = await db.all(
      `SELECT n.* FROM notes n
       JOIN note_tags nt ON n.id = nt.note_id
       WHERE nt.tag_id = ?
       ORDER BY n.updated_at DESC`,
      [tagId]
    );

    renderSidebar();
    renderNoteList();
    await renderEditor(null);

  } else if (action === 'new-notebook') {
    try {
      const result = await db.run("INSERT INTO notebooks (name) VALUES ('Untitled Notebook')");
      const newNotebook = await db.get('SELECT * FROM notebooks WHERE id = ?', [result.lastInsertId]);
      store.notebooks.push(newNotebook);
      store.notebooks.sort((a, b) => a.name.localeCompare(b.name));
      store.currentNotebook = newNotebook.id;
      store.currentTag = null;
      store.renamingNotebookId = null;
      store.notes = [];
      renderSidebar();
      renderNoteList();
      await renderEditor(null);
    } catch (error) {
      console.error('Failed to create notebook:', error);
    }
  }
}

// Handle note list clicks
async function handleNoteListClick(event) {
  const target = event.target.closest('[data-action]');
  if (!target) return;

  const action = target.dataset.action;

  if (action === 'delete-notebook-header') {
    const notebookId = parseInt(target.dataset.id);
    await deleteNotebook(notebookId);
    return;
  }

  if (action === 'select-note') {
    const noteId = parseInt(target.dataset.id);
    setRoute('note/' + noteId);
    store.currentNote = noteId;

    // Fetch the full note
    const note = await db.get('SELECT * FROM notes WHERE id = ?', [noteId]);

    renderNoteList();
    await renderEditor(note);

    // Re-initialize editor after rendering
    initEditor();
    await refreshAttachmentTray();

  } else if (action === 'new-note') {
    // Create new note
    await createNote();
  }
}

// Handle theme toggle
function handleThemeToggle() {
  const newTheme = toggleTheme();
  console.log('Theme switched to:', newTheme);

  // Re-initialize Lucide icons after theme change
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

// Handle editor clicks
async function handleEditorClick(event) {
  const target = event.target.closest('[data-action]');
  if (!target) return;

  const action = target.dataset.action;

  if (action === 'delete-note') {
    if (store.currentNote) {
      await deleteNote(store.currentNote);
    }
  }
}

// Handle dashboard clicks (note cards + task actions)
async function handleDashboardClick(event) {
  const target = event.target.closest('[data-action]');
  if (!target) return;

  const action = target.dataset.action;

  if (action === 'dashboard-select-note') {
    const noteId = parseInt(target.dataset.id);
    setRoute('note/' + noteId);
    store.currentView = 'notes';
    store.currentNotebook = null;
    store.currentTag = null;
    store.currentNote = noteId;

    showNotePanels();
    store.notes = await db.all('SELECT * FROM notes ORDER BY updated_at DESC');
    const note = await db.get('SELECT * FROM notes WHERE id = ?', [noteId]);

    renderSidebar();
    renderNoteList();
    await renderEditor(note);
    initEditor();
    await refreshAttachmentTray();

  } else if (action === 'add-task') {
    const input = document.getElementById('task-input');
    const text = input?.value.trim();
    if (text) {
      await addTask(text);
      if (input) input.value = '';
    }

  } else if (action === 'toggle-task') {
    const taskId = parseInt(target.dataset.id);
    const task = store.tasks.find(t => t.id === taskId);
    if (task) {
      const newCompleted = task.completed ? 0 : 1;
      await db.run('UPDATE tasks SET completed = ? WHERE id = ?', [newCompleted, taskId]);
      task.completed = newCompleted;
      sortTasks();
      rerenderActiveView();
    }

  } else if (action === 'set-task-priority') {
    event.stopPropagation();
    const taskId  = parseInt(target.dataset.id);
    const level   = parseInt(target.dataset.priority);
    const task    = store.tasks.find(t => t.id === taskId);
    if (task) {
      const newPriority = task.priority === level ? 0 : level;
      await db.run('UPDATE tasks SET priority = ? WHERE id = ?', [newPriority, taskId]);
      task.priority = newPriority;
      sortTasks();
      rerenderActiveView();
    }

  } else if (action === 'delete-task') {
    const taskId = parseInt(target.dataset.id);
    await db.run('DELETE FROM tasks WHERE id = ?', [taskId]);
    store.tasks = store.tasks.filter(t => t.id !== taskId);
    rerenderActiveView();

  } else if (action === 'cal-prev') {
    store.calendarMonth--;
    if (store.calendarMonth < 0) { store.calendarMonth = 11; store.calendarYear--; }
    store.calendarSelectedDate = null;
    rerenderActiveView();

  } else if (action === 'cal-next') {
    store.calendarMonth++;
    if (store.calendarMonth > 11) { store.calendarMonth = 0; store.calendarYear++; }
    store.calendarSelectedDate = null;
    rerenderActiveView();

  } else if (action === 'cal-day-click') {
    const date = target.closest('[data-date]')?.dataset.date;
    if (date) {
      store.calendarSelectedDate = store.calendarSelectedDate === date ? null : date;
      rerenderActiveView();
      if (store.calendarSelectedDate) {
        setTimeout(() => document.getElementById('cal-event-input')?.focus(), 0);
      }
    }

  } else if (action === 'cal-add-event') {
    const input = document.getElementById('cal-event-input');
    const text = input?.value.trim();
    if (text) { await addCalEvent(text); if (input) input.value = ''; }

  } else if (action === 'cal-delete-event') {
    event.stopPropagation();
    const evId = parseInt(target.dataset.id);
    await db.run('DELETE FROM events WHERE id = ?', [evId]);
    store.events = store.events.filter(e => e.id !== evId);
    rerenderActiveView();

  } else if (action === 'toggle-add-widget-menu') {
    const menu = document.getElementById('add-widget-menu');
    if (!menu) return;
    menu.hidden = !menu.hidden;
    if (!menu.hidden) {
      const closeMenu = (e) => {
        if (!menu.contains(e.target) && e.target !== target) {
          menu.hidden = true;
          document.removeEventListener('click', closeMenu, true);
        }
      };
      setTimeout(() => document.addEventListener('click', closeMenu, true), 0);
    }

  } else if (action === 'add-notebook-widget') {
    const widgetId = `notebook-${target.dataset.id}`;
    const layout = store.settings.dashboard.layout;
    if (!layout.find(l => l.id === widgetId)) {
      layout.push({ id: widgetId, x: 0, y: 9999, w: 4, h: 5 });
      saveSettings(store.settings);
    }
    renderDashboard();

  } else if (action === 'add-note-widget') {
    const widgetId = `note-${target.dataset.id}`;
    const layout = store.settings.dashboard.layout;
    if (!layout.find(l => l.id === widgetId)) {
      layout.push({ id: widgetId, x: 0, y: 9999, w: 4, h: 4 });
      saveSettings(store.settings);
    }
    renderDashboard();

  } else if (action === 'remove-widget') {
    const widgetId = target.dataset.widgetId;
    store.settings.dashboard.layout = store.settings.dashboard.layout.filter(l => l.id !== widgetId);
    saveSettings(store.settings);
    renderDashboard();

  } else if (action === 'reset-layout') {
    const { loadSettings } = await import('./settings.js');
    const s = store.settings;
    delete s.dashboard.layout;
    const fresh = loadSettings();
    s.dashboard.layout = fresh.dashboard.layout;
    saveSettings(s);
    renderDashboard();
  }
}

// Handle dashboard keydown (Enter on task / calendar inputs)
async function handleDashboardKeydown(event) {
  if (event.key !== 'Enter') return;

  if (event.target.id === 'task-input') {
    const text = event.target.value.trim();
    if (text) { await addTask(text); event.target.value = ''; }

  } else if (event.target.id === 'cal-event-input') {
    const text = event.target.value.trim();
    if (text) { await addCalEvent(text); event.target.value = ''; }
  }
}

function sortTasks() {
  const dir = store.settings?.dashboard?.tasksSortOrder === 'asc' ? -1 : 1;
  store.tasks.sort((a, b) =>
    a.completed - b.completed || dir * (b.priority - a.priority) || a.created_at.localeCompare(b.created_at)
  );
}

// Apply a settings change from a form control
function applySettingChange(input) {
  const path = input.dataset.setting;
  if (!path) return false;

  let value;
  if (input.type === 'checkbox') {
    value = input.checked;
  } else if (input.type === 'radio') {
    if (!input.checked) return false;
    const n = Number(input.value);
    value = isNaN(n) ? input.value : n;
  } else if (input.type === 'number') {
    const n = parseInt(input.value);
    const min = parseInt(input.min) || 1;
    const max = parseInt(input.max) || 100;
    if (isNaN(n)) return false;
    value = Math.max(min, Math.min(max, n));
  } else {
    value = input.value;
  }

  // Walk path and set value
  const parts = path.split('.');
  let obj = store.settings;
  for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
  obj[parts[parts.length - 1]] = value;

  saveSettings(store.settings);
  return true;
}

// Handle checkbox / radio changes — re-render settings view immediately
function handleSettingsChange(event) {
  const input = event.target;
  if (!applySettingChange(input)) return;

  if (input.dataset.setting === 'dashboard.tasksSortOrder') sortTasks();

  // Re-render settings to update disabled states
  renderSettingsView();
}

// Handle number input — save on change but don't re-render (avoids focus loss while typing)
function handleSettingsInput(event) {
  const input = event.target;
  if (input.type !== 'number') return;
  applySettingChange(input);
}

// Re-render whichever feature view is currently active
function rerenderActiveView() {
  if (store.currentView === 'dashboard') renderDashboard();
  else if (store.currentView === 'tasks') renderTasksView();
  else if (store.currentView === 'calendar') renderCalendarView();
  else if (store.currentView === 'settings') renderSettingsView();
}

// Add a calendar event
async function addCalEvent(title) {
  const date = store.calendarSelectedDate;
  if (!date || !title) return;
  const time = document.getElementById('cal-event-time')?.value || null;
  const result = await db.run(
    'INSERT INTO events (title, date, time) VALUES (?, ?, ?)',
    [title, date, time || null]
  );
  const newEvent = await db.get('SELECT * FROM events WHERE id = ?', [result.lastInsertId]);
  store.events.push(newEvent);
  store.events.sort((a, b) =>
    a.date.localeCompare(b.date) ||
    (a.time || '').localeCompare(b.time || '') ||
    a.id - b.id
  );
  rerenderActiveView();
  setTimeout(() => document.getElementById('cal-event-input')?.focus(), 0);
}

// Add a new task
async function addTask(text) {
  const result = await db.run('INSERT INTO tasks (text) VALUES (?)', [text]);
  const newTask = await db.get('SELECT * FROM tasks WHERE id = ?', [result.lastInsertId]);
  store.tasks.unshift(newTask);
  sortTasks();
  rerenderActiveView();
}

// Create new note
async function createNote() {
  try {
    // Insert new note
    const result = await db.run(
      'INSERT INTO notes (notebook_id, title, body) VALUES (?, ?, ?)',
      [store.currentNotebook || null, '', '']
    );

    const newNoteId = result.lastInsertId;

    // Fetch the new note
    const newNote = await db.get('SELECT * FROM notes WHERE id = ?', [newNoteId]);

    // Add to store.notes at the beginning (most recent)
    store.notes.unshift(newNote);

    // Select the new note
    store.currentNote = newNoteId;

    // Re-render
    renderNoteList();
    await renderEditor(newNote);

    // Initialize editor
    initEditor();
    await refreshAttachmentTray();

    // Focus title input
    setTimeout(() => {
      const titleInput = document.querySelector('.editor-title');
      if (titleInput) {
        titleInput.focus();
      }
    }, 50);

    console.log('New note created:', newNoteId);
  } catch (error) {
    console.error('Failed to create note:', error);
    alert('Failed to create note');
  }
}

// Build FTS query helper
function buildFtsQuery(raw) {
  return raw.trim()
    .split(/\s+/)
    .map(w => w.replace(/['"*]/g, '') + '*')
    .join(' ');
}

// Handle search
async function handleSearch(query) {
  // Clear debounce timer
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = null;
  }

  if (!query || !query.trim()) {
    // Restore previous context
    currentSearchQuery = null;
    const prevNotebook = previousContext.notebook;
    const prevTag = previousContext.tag;

    store.currentNotebook = prevNotebook;
    store.currentTag = prevTag;

    // Reload notes based on context
    try {
      if (prevNotebook) {
        store.notes = await db.all(
          'SELECT * FROM notes WHERE notebook_id = ? ORDER BY updated_at DESC',
          [prevNotebook]
        );
      } else if (prevTag) {
        store.notes = await db.all(
          `SELECT n.* FROM notes n
           JOIN note_tags nt ON n.id = nt.note_id
           WHERE nt.tag_id = ?
           ORDER BY n.updated_at DESC`,
          [prevTag]
        );
      } else {
        // No filter - load all notes
        store.notes = await db.all('SELECT * FROM notes ORDER BY updated_at DESC');
      }
    } catch (error) {
      console.error('Failed to restore notes:', error);
    }

    renderSidebar();
    renderNoteList();
    return;
  }

  // Save previous context before searching
  if (!currentSearchQuery) {
    previousContext = {
      notebook: store.currentNotebook,
      tag: store.currentTag
    };
  }

  currentSearchQuery = query;

  try {
    // Query FTS5
    const searchResults = await db.all(
      `SELECT n.* FROM notes n
       JOIN notes_fts f ON n.id = f.rowid
       WHERE notes_fts MATCH ?
       ORDER BY rank`,
      [buildFtsQuery(query)]
    );

    // Clear current filters
    store.currentNotebook = null;
    store.currentTag = null;
    store.notes = searchResults;

    renderSidebar();
    renderNoteList(query);
  } catch (error) {
    console.error('Search failed:', error);
    showToast('Search failed. Please try again.', 'error');
  }
}

// Delete note
async function deleteNote(noteId) {
  try {
    await showConfirmDialog(
      'Delete note?',
      'This action cannot be undone.',
      async () => {
        try {
          // Delete from database
          await db.run('DELETE FROM notes WHERE id = ?', [noteId]);

          // Remove from store
          store.notes = store.notes.filter(n => n.id !== noteId);

          // If deleted note was selected, clear selection
          if (store.currentNote === noteId) {
            store.currentNote = null;
          }

          // Re-render
          renderNoteList(currentSearchQuery);
          await renderEditor(null);

          console.log('Note deleted:', noteId);
        } catch (error) {
          console.error('Delete failed:', error);
          showToast('Could not delete note. Please try again.', 'error');
        }
      }
    );
  } catch (error) {
    // User cancelled - do nothing
  }
}

// Delete notebook
async function deleteNotebook(notebookId) {
  try {
    await showConfirmDialog(
      'Delete notebook?',
      'Notes in this notebook will be unassigned.',
      async () => {
        try {
          // Delete from database
          await db.run('DELETE FROM notebooks WHERE id = ?', [notebookId]);

          // Remove from store
          store.notebooks = store.notebooks.filter(n => n.id !== notebookId);

          // Update notes in store to have notebook_id = null
          store.notes.forEach(note => {
            if (note.notebook_id === notebookId) {
              note.notebook_id = null;
            }
          });

          // If deleted notebook was selected, clear selection
          if (store.currentNotebook === notebookId) {
            store.currentNotebook = null;
            // Reload all notes
            store.notes = await db.all('SELECT * FROM notes ORDER BY updated_at DESC');
          }

          // Re-render
          renderSidebar();
          renderNoteList(currentSearchQuery);

          console.log('Notebook deleted:', notebookId);
        } catch (error) {
          console.error('Delete notebook failed:', error);
          showToast('Could not delete notebook. Please try again.', 'error');
        }
      }
    );
  } catch (error) {
    // User cancelled - do nothing
  }
}

// Delete tag
async function deleteTag(tagId) {
  try {
    await showConfirmDialog(
      'Delete tag?',
      'It will be removed from all notes.',
      async () => {
        try {
          await db.run('DELETE FROM tags WHERE id = ?', [tagId]);
          store.tags = store.tags.filter(t => t.id !== tagId);
          if (store.currentTag === tagId) {
            store.currentTag = null;
            store.notes = await db.all('SELECT * FROM notes ORDER BY updated_at DESC');
            renderNoteList(currentSearchQuery);
          }
          renderSidebar();
        } catch (error) {
          console.error('Delete tag failed:', error);
          showToast('Could not delete tag.', 'error');
        }
      }
    );
  } catch (error) {
    // cancelled
  }
}

// Export for console debugging
window.db = db;
window.store = store;
window.createNote = createNote;
window.deleteNote = deleteNote;
window.deleteNotebook = deleteNotebook;
