// Main application entry point - Notely

import { db, waitForReady } from './db.js';
import { store } from './store.js';
import { renderSidebar, renderNoteList, renderEditor, renderDashboard, renderTasksView, renderCalendarView, renderSettingsView, showNotePanels, showConfirmDialog, showEventModal, showToast, refreshDashboardWidgets, escapeHtml } from './render.js';
import { executeTool } from './tools.js';
import { saveSettings } from './settings.js';
import { connect as connectGoogleCalendar, disconnect as disconnectGoogleCalendar, refreshEvents, createEvent as createGoogleEvent, updateEvent as updateGoogleEvent, deleteEvent as deleteGoogleEvent, getEvent as getGoogleEvent, isActive as isGoogleSyncActive } from './google-calendar.js';
import { initTheme, toggleTheme, applyAppearance } from './theme.js';
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
  if (hash === 'tasks') return { view: 'tasks-redirect' };
  if (hash === 'dashboard') return { view: 'dashboard' };
  if (hash === 'calendar')  return { view: 'calendar' };
  if (hash === 'settings')  return { view: 'settings' };
  const [section, id] = hash.split('/');
  if (section === 'tasklist' && id) return { view: 'tasklist', id: parseInt(id) };
  if (section === 'notebook' && id) return { view: 'notebook', id: parseInt(id) };
  if (section === 'tag'      && id) return { view: 'tag',      id: parseInt(id) };
  if (section === 'note'     && id) return { view: 'note',     id: parseInt(id) };
  return { view: 'all' };
}

async function applyRoute() {
  const route = parseRoute();

  if (route.view === 'dashboard') {
    store.currentView = 'dashboard';
    store.currentTaskList = null;
    store.currentNotebook = null;
    store.currentTag = null;
    store.currentNote = null;
    store.notes = await db.all(
      `SELECT n.*, nb.name as notebook_name
       FROM notes n LEFT JOIN notebooks nb ON n.notebook_id = nb.id
       ORDER BY n.created_at DESC LIMIT 50`
    );
    store.tasks = await db.all('SELECT * FROM tasks ORDER BY completed ASC, priority DESC, created_at ASC');
    renderSidebar();
    renderDashboard();

  } else if (route.view === 'tasks-redirect') {
    // Old #tasks link — redirect to first task list
    const first = store.taskLists[0];
    if (first) { setRoute('tasklist/' + first.id); return; }
    renderSidebar();

  } else if (route.view === 'tasklist') {
    store.currentView = 'tasks';
    store.currentTaskList = route.id;
    store.currentNotebook = null;
    store.currentTag = null;
    store.currentNote = null;
    store.tasks = await db.all(
      'SELECT * FROM tasks WHERE list_id = ? ORDER BY completed ASC, priority DESC, created_at ASC',
      [route.id]
    );
    renderSidebar();
    renderTasksView();

  } else if (route.view === 'calendar') {
    store.currentView = 'calendar';
    store.currentNotebook = null;
    store.currentTag = null;
    store.currentNote = null;
    renderSidebar();
    renderCalendarView();
    loadCalendarEvents(true);

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

    // Fetch task lists
    store.taskLists = await db.all('SELECT * FROM task_lists ORDER BY created_at ASC');

    // Fetch tasks (loaded per-list on route; start empty)
    store.tasks = [];
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

  // Apply user appearance customisations (colors, bg image) before revealing the app
  applyAppearance(store.settings.appearance);

  // Restore route from URL hash (or default to all-notes view)
  await applyRoute();

  // Google Calendar is the only source of event data — fetch on load, then
  // keep refreshing while the tab stays open so events created elsewhere
  // (another device, Google Calendar itself) show up here too.
  loadCalendarEvents(false);
  setInterval(() => loadCalendarEvents(true), 5 * 60 * 1000);

  // Reveal the app now that theme + layout are fully applied (prevents flicker)
  document.documentElement.classList.remove('app-loading');

  // Register tools via WebMCP (Chrome 146+).
  // The extension may inject document.modelContext after the page loads,
  // so poll until it appears (stops after 30 s).
  (function pollWebMCP() {
    if (document.modelContext) {
      registerWebMCPTools().catch(() => {});
    } else {
      let attempts = 0;
      const iv = setInterval(() => {
        if (document.modelContext) {
          clearInterval(iv);
          registerWebMCPTools().catch(() => {});
        } else if (++attempts > 60) {
          clearInterval(iv);
        }
      }, 500);
    }
  })();

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
  document.getElementById('tasks-view')?.addEventListener('change', handleTasksViewChange);

  // Calendar view event delegation
  document.getElementById('calendar-view')?.addEventListener('click', handleDashboardClick);
  document.getElementById('calendar-view')?.addEventListener('keydown', handleDashboardKeydown);

  // Header contextual slot (legacy; add-widget FAB is now on document.body)
  document.getElementById('header-contextual')?.addEventListener('click', handleDashboardClick);


  // Settings view event delegation
  document.getElementById('settings-view')?.addEventListener('change', handleSettingsChange);
  document.getElementById('settings-view')?.addEventListener('input', handleSettingsInput);
  document.getElementById('settings-view')?.addEventListener('click', handleSettingsClick);

  // Hash-based routing (back/forward navigation)
  window.addEventListener('hashchange', applyRoute);

  // Theme toggle (header removed; handled via sidebar + settings click delegation)

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

  if (action === 'toggle-sidebar') {
    const sidebar = document.getElementById('sidebar');
    const collapsed = sidebar.classList.toggle('collapsed');
    localStorage.setItem('notely-sidebar-collapsed', collapsed);
    renderSidebar();
    return;
  }

  if (action === 'toggle-add-widget-menu') {
    handleDashboardClick(event);
    return;
  }

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
    store.currentTaskList = null;
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
    store.tasks = await db.all('SELECT * FROM tasks ORDER BY completed ASC, priority DESC, created_at ASC');

    renderSidebar();
    renderDashboard();

  } else if (action === 'select-tasklist') {
    const listId = parseInt(target.dataset.id);
    setRoute('tasklist/' + listId);
    store.currentView = 'tasks';
    store.currentTaskList = listId;
    store.currentNotebook = null;
    store.currentTag = null;
    store.currentNote = null;
    store.tasks = await db.all(
      'SELECT * FROM tasks WHERE list_id = ? ORDER BY completed ASC, priority DESC, created_at ASC',
      [listId]
    );
    renderSidebar();
    renderTasksView();

  } else if (action === 'new-task-list') {
    const result = await db.run("INSERT INTO task_lists (name, type) VALUES ('Untitled', 'basic')");
    const newList = await db.get('SELECT * FROM task_lists WHERE id = ?', [result.lastInsertId]);
    store.taskLists.push(newList);
    store.renamingTaskListId = newList.id;
    store.currentTaskList = newList.id;
    store.currentView = 'tasks';
    store.tasks = [];
    setRoute('tasklist/' + newList.id);
    renderSidebar();
    renderTasksView();

  } else if (action === 'rename-task-list') {
    event.stopPropagation();
    store.renamingTaskListId = parseInt(target.dataset.id);
    renderSidebar();

  } else if (action === 'delete-task-list') {
    event.stopPropagation();
    const listId = parseInt(target.dataset.id);
    const list = store.taskLists.find(l => l.id === listId);
    if (!list) return;
    const confirmed = await showConfirmDialog(`Delete "${list.name}"? All tasks in it will be removed.`);
    if (!confirmed) return;
    await db.run('DELETE FROM task_lists WHERE id = ?', [listId]);
    store.taskLists = store.taskLists.filter(l => l.id !== listId);
    if (store.currentTaskList === listId) {
      store.currentTaskList = null;
      store.tasks = [];
      store.currentView = 'notes';
      showNotePanels();
      store.notes = await db.all('SELECT * FROM notes ORDER BY updated_at DESC');
      renderSidebar(); renderNoteList(); await renderEditor(null);
    } else {
      renderSidebar();
    }

  } else if (action === 'select-calendar') {
    setRoute('calendar');
    store.currentView = 'calendar';
    store.currentNotebook = null;
    store.currentTag = null;
    store.currentNote = null;
    if (!store.calendarSelectedDate) {
      const t = new Date();
      const p = n => String(n).padStart(2, '0');
      store.calendarSelectedDate = `${t.getFullYear()}-${p(t.getMonth()+1)}-${p(t.getDate())}`;
    }
    renderSidebar();
    renderCalendarView();
    loadCalendarEvents(true);

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
  toggleTheme();
  renderSidebar();
  if (store.currentView === 'settings') renderSettingsView();
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
      const widgetListId = parseInt(target.closest('[data-widget-list-id]')?.dataset?.widgetListId) || null;
      const listId = widgetListId || store.currentTaskList;
      const list = store.taskLists.find(l => l.id === listId);
      const qty = list?.type === 'quantity'
        ? (parseInt(document.getElementById('task-qty-input')?.value) || 1)
        : 1;
      await addTask(text, qty, listId);
      if (input) input.value = '';
      const qtyInput = document.getElementById('task-qty-input');
      if (qtyInput) qtyInput.value = '1';
    }

  } else if (action === 'set-task-quantity') {
    event.stopPropagation();
    const taskId = parseInt(target.dataset.id);
    const val = parseInt(target.value);
    if (isNaN(val) || val < 1) return;
    await db.run('UPDATE tasks SET quantity = ? WHERE id = ?', [val, taskId]);
    const task = store.tasks.find(t => t.id === taskId);
    if (task) task.quantity = val;

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
    loadCalendarEvents(true);

  } else if (action === 'cal-next') {
    store.calendarMonth++;
    if (store.calendarMonth > 11) { store.calendarMonth = 0; store.calendarYear++; }
    store.calendarSelectedDate = null;
    rerenderActiveView();
    loadCalendarEvents(true);

  } else if (action === 'cal-day-click') {
    const date = target.closest('[data-date]')?.dataset.date;
    if (date) {
      store.calendarSelectedDate = store.calendarSelectedDate === date ? null : date;
      rerenderActiveView();
    }

  } else if (action === 'ds-hour-click') {
    const hour = target.closest('[data-hour]')?.dataset.hour;
    if (hour) await openNewEventModal(currentScheduleDate(), hour);

  } else if (action === 'cal-refresh') {
    loadCalendarEvents(false);
    rerenderActiveView();

  } else if (action === 'cal-new-event') {
    if (store.calendarSelectedDate) await openNewEventModal(store.calendarSelectedDate);

  } else if (action === 'cal-edit-event') {
    const evId = target.dataset.id;
    const calId = target.dataset.calendarId;
    const ev = store.events.find(e => e.id === evId && e.calendarId === calId);
    if (ev) await openEditEventModal(ev);

  } else if (action === 'cal-delete-event') {
    event.stopPropagation();
    const evId = target.dataset.id;
    const calId = target.dataset.calendarId;
    const deletedEvent = store.events.find(e => e.id === evId && e.calendarId === calId);
    try {
      await showConfirmDialog(
        'Delete event?',
        'This action cannot be undone.',
        async () => {
          try {
            await deleteGoogleEvent(calId, evId, { scope: 'this', recurringEventId: deletedEvent?.recurringEventId });
          } catch (err) {
            console.error('Google Calendar delete failed:', err);
            showToast('Could not delete event. Please try again.', 'error');
            return;
          }
          store.events = store.events.filter(e => !(e.id === evId && e.calendarId === calId));
          rerenderActiveView();
        }
      );
    } catch (error) {
      // User cancelled - do nothing
    }

  } else if (action === 'toggle-add-widget-menu') {
    // Close if already open
    const existing = document.getElementById('add-widget-menu');
    if (existing) { existing.remove(); return; }

    // Build menu content
    const tlItems = store.taskLists.map(list => {
      const icon = list.type === 'priority' ? 'bell' : list.type === 'quantity' ? 'shopping-cart' : 'check-square';
      return `<div class="dash-add-menu-item" data-action="add-tasklist-widget" data-id="${list.id}">
        <i data-lucide="${icon}" width="12" height="12"></i> ${escapeHtml(list.name)}</div>`;
    }).join('');
    const nbItems = store.notebooks.map(nb =>
      `<div class="dash-add-menu-item" data-action="add-notebook-widget" data-id="${nb.id}">
        <i data-lucide="book" width="12" height="12"></i> ${escapeHtml(nb.name)}</div>`).join('');
    const noteItems = store.notes.slice(0, 30).map(n =>
      `<div class="dash-add-menu-item" data-action="add-note-widget" data-id="${n.id}">
        <i data-lucide="file-text" width="12" height="12"></i> ${escapeHtml(n.title || 'Untitled')}</div>`).join('');

    const menu = document.createElement('div');
    menu.id = 'add-widget-menu';
    menu.className = 'dash-add-widget-menu dash-add-widget-menu-fixed';
    menu.innerHTML = `
      ${store.taskLists.length ? `<div class="dash-add-menu-section">Task Lists</div>${tlItems}` : ''}
      ${store.notebooks.length ? `<div class="dash-add-menu-section">Notebooks</div>${nbItems}` : ''}
      <div class="dash-add-menu-section">Notes</div>
      ${noteItems || '<div class="dash-add-menu-item dash-add-menu-empty">No notes yet</div>'}`;
    document.body.appendChild(menu);
    if (window.lucide) window.lucide.createIcons({ nodes: Array.from(menu.querySelectorAll('[data-lucide]')) });

    // Position to the right of the triggering sidebar item
    const rect = target.getBoundingClientRect();
    menu.style.top = `${rect.top}px`;
    menu.style.left = `${rect.right + 4}px`;

    // Route menu item clicks through the dashboard handler
    menu.addEventListener('click', handleDashboardClick);

    const closeMenu = (e) => {
      if (!menu.contains(e.target) && e.target !== target && !target.contains(e.target)) {
        menu.remove();
        document.removeEventListener('click', closeMenu, true);
      }
    };
    setTimeout(() => document.addEventListener('click', closeMenu, true), 0);

  } else if (action === 'add-tasklist-widget') {
    document.getElementById('add-widget-menu')?.remove();
    const widgetId = `tasklist-${target.dataset.id}`;
    const layout = store.settings.dashboard.layout;
    if (!layout.find(l => l.id === widgetId)) {
      layout.push({ id: widgetId, x: 0, y: 9999, w: 4, h: 5 });
      saveSettings(store.settings);
    }
    renderDashboard();

  } else if (action === 'add-notebook-widget') {
    document.getElementById('add-widget-menu')?.remove();
    const widgetId = `notebook-${target.dataset.id}`;
    const layout = store.settings.dashboard.layout;
    if (!layout.find(l => l.id === widgetId)) {
      layout.push({ id: widgetId, x: 0, y: 9999, w: 4, h: 5 });
      saveSettings(store.settings);
    }
    renderDashboard();

  } else if (action === 'add-note-widget') {
    document.getElementById('add-widget-menu')?.remove();
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

  if (event.target.id === 'task-input' || event.target.id === 'task-qty-input') {
    const input = document.getElementById('task-input');
    const text = input?.value.trim();
    if (text) {
      const widgetListId = parseInt(event.target.closest('[data-widget-list-id]')?.dataset?.widgetListId) || null;
      const listId = widgetListId || store.currentTaskList;
      const list = store.taskLists.find(l => l.id === listId);
      const qty = list?.type === 'quantity'
        ? (parseInt(document.getElementById('task-qty-input')?.value) || 1)
        : 1;
      await addTask(text, qty, listId);
      if (input) input.value = '';
      const qtyInput = document.getElementById('task-qty-input');
      if (qtyInput) qtyInput.value = '1';
    }
  }
}

async function handleTasksViewChange(event) {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  if (target.dataset.action === 'set-task-quantity') {
    const taskId = parseInt(target.dataset.id);
    const val = Math.max(1, parseInt(target.value) || 1);
    target.value = val;
    await db.run('UPDATE tasks SET quantity = ? WHERE id = ?', [val, taskId]);
    const task = store.tasks.find(t => t.id === taskId);
    if (task) task.quantity = val;
  } else if (target.dataset.action === 'set-tasklist-type') {
    const listId = parseInt(target.dataset.listId);
    const type = target.value;
    await db.run('UPDATE task_lists SET type = ? WHERE id = ?', [type, listId]);
    const list = store.taskLists.find(l => l.id === listId);
    if (list) list.type = type;
    renderSidebar();
    renderTasksView();
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

  if (input.id === 'import-data-input') {
    const file = input.files?.[0];
    input.value = ''; // allow re-selecting the same file later
    if (file) importDataFromFile(file, document.querySelector('[data-action="import-data-pick"]'));
    return;
  }

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

// Handle button clicks in settings view
async function handleSettingsClick(event) {
  const btn = event.target.closest('[data-action]');
  if (!btn) return;
  if (btn.dataset.action === 'toggle-theme') {
    handleThemeToggle();
  } else if (btn.dataset.action === 'clear-all-data') {
    await clearAllData();
  } else if (btn.dataset.action === 'google-connect') {
    btn.disabled = true;
    try {
      await connectGoogleCalendar();
      showToast('Connected to Google Calendar.', 'success');
      await refreshEvents();
      rerenderActiveView();
    } catch (error) {
      console.error('Google Calendar connect failed:', error);
      showToast('Could not connect to Google Calendar. Please try again.', 'error');
    }
    renderSettingsView();
  } else if (btn.dataset.action === 'google-disconnect') {
    btn.disabled = true;
    try {
      await disconnectGoogleCalendar();
      showToast('Disconnected from Google Calendar.', 'success');
      renderSidebar();
      if (store.currentView === 'calendar' || store.currentView === 'dashboard') rerenderActiveView();
    } catch (error) {
      console.error('Google Calendar disconnect failed:', error);
      showToast('Could not disconnect. Please try again.', 'error');
    }
    renderSettingsView();
  } else if (btn.dataset.action === 'google-refresh') {
    btn.disabled = true;
    try {
      await refreshEvents();
      rerenderActiveView();
    } catch (error) {
      console.error('Google Calendar refresh failed:', error);
      showToast('Refresh failed. Please try again.', 'error');
    }
    renderSettingsView();
  } else if (btn.dataset.action === 'toggle-google-calendar') {
    const calId = btn.dataset.id;
    const cal = store.settings.googleCalendar.calendars.find(c => c.id === calId);
    if (cal) {
      cal.selected = !cal.selected;
      saveSettings(store.settings);
      renderSettingsView();
      loadCalendarEvents(false);
    }
  } else if (btn.dataset.action === 'export-data') {
    const originalLabel = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = 'Exporting…';
    await exportData();
    btn.disabled = false;
    btn.innerHTML = originalLabel;
  } else if (btn.dataset.action === 'import-data-pick') {
    document.getElementById('import-data-input')?.click();
  }
}

// Tables in parent-before-child order (matches FK dependency direction).
// notes_fts is deliberately excluded — it's an external-content FTS5 table kept in
// sync automatically by the notes_ai/notes_ad/notes_au triggers already defined in
// db.worker.js's createSchema(), so it's repopulated for free as `notes` rows are
// deleted/re-inserted below.
const BACKUP_TABLES = ['notebooks', 'tags', 'notes', 'note_tags', 'attachments', 'task_lists', 'tasks'];

// Download all data as a portable JSON backup (plain SQL dump — no raw OPFS/file
// access, so it can't conflict with the async OPFS VFS's own locking)
async function exportData() {
  try {
    const dump = { version: 1, exportedAt: new Date().toISOString(), tables: {} };
    for (const table of BACKUP_TABLES) {
      dump.tables[table] = await db.all(`SELECT * FROM ${table}`);
    }
    const blob = new Blob([JSON.stringify(dump)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `notely-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast('Backup downloaded.', 'success');
  } catch (error) {
    console.error('Export failed:', error);
    showToast('Export failed. Please try again.', 'error');
  }
}

// Replace all data with the contents of a backup file, via plain DELETE/INSERT.
// `btn` (the visible "Import data" button) is optional — when given, its label is
// used to show live progress, since this walks every row one at a time through the
// Worker and can take a noticeable moment on a larger backup.
async function importDataFromFile(file, btn) {
  const confirmed = await showTypeConfirmDialog(
    'Import data?',
    'This will <strong>replace everything currently in Notely</strong> with the contents of the backup file. This cannot be undone.',
    'IMPORT'
  );
  if (!confirmed) return;

  const originalLabel = btn?.innerHTML;
  const setProgress = (text) => { if (btn) btn.textContent = text; };

  if (btn) btn.disabled = true;

  try {
    setProgress('Reading file…');
    const dump = JSON.parse(await file.text());
    if (!dump || typeof dump.tables !== 'object') {
      throw new Error('Not a valid Notely backup file');
    }

    setProgress('Clearing existing data…');
    // Children before parents
    for (const table of [...BACKUP_TABLES].reverse()) {
      await db.run(`DELETE FROM ${table}`);
    }

    const totalRows = BACKUP_TABLES.reduce((sum, t) => sum + (dump.tables[t]?.length || 0), 0);
    let done = 0;

    // Parents before children
    for (const table of BACKUP_TABLES) {
      for (const row of dump.tables[table] || []) {
        const cols = Object.keys(row);
        if (cols.length) {
          const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
          await db.run(sql, cols.map(c => row[c]));
        }
        done++;
        if (totalRows) setProgress(`Importing… ${done}/${totalRows}`);
      }
    }

    setProgress('Reloading…');
    showToast('Data imported. Reloading…', 'success');
    setTimeout(() => location.reload(), 400);
  } catch (error) {
    console.error('Import failed:', error);
    showToast('Import failed. The file may not be a valid Notely backup.', 'error');
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalLabel;
    }
  }
}

async function clearAllData() {
  const confirmed = await showTypeConfirmDialog(
    'Clear all data?',
    'This will permanently delete <strong>all notes, notebooks, tasks, and task lists</strong>. This cannot be undone. (Google Calendar events are not affected.)',
    'DELETE'
  );
  if (!confirmed) return;

  await db.run('DELETE FROM notes');
  await db.run('DELETE FROM notebooks');
  await db.run('DELETE FROM tasks');
  await db.run('DELETE FROM task_lists');

  store.notes = [];
  store.notebooks = [];
  store.tasks = [];
  store.taskLists = [];
  store.currentNote = null;
  store.currentNotebook = null;
  store.currentTaskList = null;

  renderSidebar();
  showToast('All data cleared.', 'success');
}

// Dialog that requires the user to type a specific word before confirming
function showTypeConfirmDialog(title, htmlMessage, requiredWord) {
  const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  return new Promise((resolve) => {
    const container = document.getElementById('dialog-container');
    if (!container) { resolve(false); return; }

    container.innerHTML = `
      <div class="dialog-overlay">
        <div class="confirm-dialog">
          <div class="confirm-dialog-title">${esc(title)}</div>
          <div class="confirm-dialog-body">${htmlMessage}</div>
          <div class="confirm-dialog-body" style="margin-top:12px">
            Type <strong>${esc(requiredWord)}</strong> to confirm:
          </div>
          <input id="type-confirm-input" type="text" class="settings-text-input"
            placeholder="${esc(requiredWord)}" autocomplete="off"
            style="margin-top:8px;width:100%;box-sizing:border-box" />
          <div class="confirm-dialog-buttons">
            <button class="confirm-dialog-button cancel" id="type-confirm-cancel">Cancel</button>
            <button class="confirm-dialog-button danger" id="type-confirm-ok" disabled>Confirm</button>
          </div>
        </div>
      </div>`;

    const input = container.querySelector('#type-confirm-input');
    const okBtn = container.querySelector('#type-confirm-ok');
    const cancelBtn = container.querySelector('#type-confirm-cancel');

    const close = (result) => { container.innerHTML = ''; resolve(result); };

    input.addEventListener('input', () => {
      okBtn.disabled = input.value !== requiredWord;
    });
    okBtn.addEventListener('click', () => { if (input.value === requiredWord) close(true); });
    cancelBtn.addEventListener('click', () => close(false));
    container.querySelector('.dialog-overlay').addEventListener('click', e => {
      if (e.target === e.currentTarget) close(false);
    });

    setTimeout(() => input.focus(), 50);
  });
}

// Re-render whichever feature view is currently active
function rerenderActiveView() {
  if (store.currentView === 'dashboard') renderDashboard();
  else if (store.currentView === 'tasks') renderTasksView();
  else if (store.currentView === 'calendar') renderCalendarView();
  else if (store.currentView === 'settings') renderSettingsView();
}

// Fetch events for the currently visible calendar range from Google Calendar
// (background = true keeps whatever's already rendered visible while the
// refetch is in flight — no blocking spinner except on first load/connect).
function loadCalendarEvents(background) {
  if (!isGoogleSyncActive()) return;
  refreshEvents({ background })
    .then(() => {
      if (store.currentView === 'calendar' || store.currentView === 'dashboard') rerenderActiveView();
    })
    .catch(err => console.warn('[google-calendar] refresh failed:', err.message));
}

// The date whose schedule the day-schedule pane is currently showing
function currentScheduleDate() {
  const pad = n => String(n).padStart(2, '0');
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${pad(today.getMonth()+1)}-${pad(today.getDate())}`;
  return store.calendarSelectedDate || todayStr;
}

function eventSortComparator(a, b) {
  return a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || '') || a.id.localeCompare(b.id);
}

// Open the create-event modal and save directly to Google Calendar
async function openNewEventModal(dateStr, startTime = null) {
  const gcal = store.settings.googleCalendar;
  if (!isGoogleSyncActive() || !gcal.writeCalendarId) {
    showToast('Connect Google Calendar in Settings to add events.', 'error');
    return;
  }

  const result = await showEventModal({ mode: 'create', dateStr, startTime });
  if (!result || result.action !== 'save') return;

  try {
    const newEvent = await createGoogleEvent(gcal.writeCalendarId, result.data);
    store.events.push(newEvent);
    store.events.sort(eventSortComparator);
    rerenderActiveView();
  } catch (err) {
    console.error('Google Calendar create failed:', err);
    showToast('Could not create event. Please try again.', 'error');
  }
}

// Open the edit modal for an existing event, exposing start/end, recurrence and color
async function openEditEventModal(ev) {
  let recurrencePreset = ev.recurrencePreset;
  if (ev.recurringEventId) {
    // Instances don't carry their own `recurrence` field — fetch the series
    // master so the "Repeats" dropdown reflects the actual series setting.
    try {
      const master = await getGoogleEvent(ev.calendarId, ev.recurringEventId);
      recurrencePreset = master.recurrencePreset;
    } catch (err) {
      console.warn('Could not load recurring series details:', err.message);
    }
  }

  const result = await showEventModal({ mode: 'edit', event: { ...ev, recurrencePreset } });
  if (!result) return;

  if (result.action === 'delete') {
    try {
      await deleteGoogleEvent(ev.calendarId, ev.id, { scope: result.scope, recurringEventId: ev.recurringEventId });
      loadCalendarEvents(false);
      rerenderActiveView();
    } catch (err) {
      console.error('Google Calendar delete failed:', err);
      showToast('Could not delete event. Please try again.', 'error');
    }
    return;
  }

  // Recurrence only applies when editing the whole series (or a plain,
  // non-recurring event, where there's no "this vs all" distinction).
  const scope = ev.recurringEventId ? result.scope : 'all';
  try {
    await updateGoogleEvent(ev.calendarId, ev.id, result.data, {
      scope, recurringEventId: ev.recurringEventId, originalDate: result.originalDate
    });
    // A scope:'all' edit can shift every occurrence — simplest to just
    // refetch the visible window rather than hand-patch the local cache.
    loadCalendarEvents(false);
    rerenderActiveView();
  } catch (err) {
    console.error('Google Calendar update failed:', err);
    showToast('Could not update event. Please try again.', 'error');
  }
}

// Add a new task to the current list
async function addTask(text, quantity = 1, listId = null) {
  listId = listId || store.currentTaskList;
  if (!listId) return;
  const result = await db.run(
    'INSERT INTO tasks (list_id, text, quantity) VALUES (?, ?, ?)',
    [listId, text, quantity]
  );
  const newTask = await db.get('SELECT * FROM tasks WHERE id = ?', [result.lastInsertId]);
  store.tasks.unshift(newTask);
  sortTasks();
  rerenderActiveView();
  setTimeout(() => document.getElementById('task-input')?.focus(), 0);
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

// Tools that mutate data and require a view refresh after execution
const MUTATING_TOOLS = new Set([
  'add_task', 'complete_task', 'delete_task', 'add_task_list', 'delete_task_list',
  'add_note', 'delete_note', 'add_notebook', 'delete_notebook',
  'add_event', 'delete_event',
  'add_widget', 'remove_widget',
]);

// Tools that also update the sidebar (new entities appear there)
const SIDEBAR_MUTATING_TOOLS = new Set([
  'add_task_list', 'delete_task_list',
  'add_note', 'delete_note', 'add_notebook', 'delete_notebook',
  'add_event', 'delete_event',
]);

function refreshCurrentView(toolName) {
  const view = store.currentView;
  if (view === 'dashboard') {
    if (toolName === 'add_widget' || toolName === 'remove_widget') {
      renderDashboard();
    } else {
      refreshDashboardWidgets(toolName);
    }
  } else if (view === 'tasks') {
    renderTasksView();
  } else if (view === 'calendar') {
    renderCalendarView();
  } else if (view === 'notes') {
    renderNoteList();
  }
  if (SIDEBAR_MUTATING_TOOLS.has(toolName)) renderSidebar();
}

// Handle tool calls relayed from background.js (extension context only)
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const { tool, args } = message || {};
    if (!tool) return false;
    executeTool(tool, args || {}).then(result => {
      sendResponse(result);
      if (!result?.error && MUTATING_TOOLS.has(tool)) refreshCurrentView(tool);
    });
    return true;
  });
}

// Register Notely tools via WebMCP (Chrome 146+) so any WebMCP-aware agent can call them
async function registerWebMCPTools() {
  if (!document.modelContext) return;

  const tools = [
    {
      name: 'list_task_lists',
      description: 'List all task lists with their id, name, and type.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true }
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
      },
      annotations: { readOnlyHint: true }
    },
    {
      name: 'add_task',
      description: 'Add a new task to a task list.',
      inputSchema: {
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
      },
      annotations: { consequentialHint: true }
    },
    {
      name: 'add_task_list',
      description: 'Create a new task list.',
      inputSchema: {
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
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true }
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
      },
      annotations: { readOnlyHint: true }
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
      },
      annotations: { readOnlyHint: true }
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
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true }
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
      description: 'List all widgets currently on the dashboard.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true }
    },
    {
      name: 'add_widget',
      description: 'Add a widget to the dashboard by id.',
      inputSchema: {
        type: 'object',
        required: ['widget_id'],
        properties: { widget_id: { type: 'string', description: 'e.g. calendar, scratchpad, tasklist-2' } }
      }
    },
    {
      name: 'remove_widget',
      description: 'Remove a widget from the dashboard by id.',
      inputSchema: {
        type: 'object',
        required: ['widget_id'],
        properties: { widget_id: { type: 'string' } }
      }
    }
  ];

  await Promise.all(tools.map(({ name, description, inputSchema, annotations }) =>
    document.modelContext.registerTool(
      { name, description, inputSchema, annotations },
      async (input) => {
        const result = await executeTool(name, input);
        if (!result?.error && MUTATING_TOOLS.has(name)) refreshCurrentView(name);
        return result;
      }
    )
  ));

  console.log('[Notely] WebMCP tools registered:', tools.map(t => t.name));
}
