// DOM rendering functions - Notely

import { store } from './store.js';
import { saveSettings } from './settings.js';
import { getAllConversations, getCurrentConvId } from './advisor.js';
import { applyAppearance } from './theme.js';

let _grid = null; // active GridStack instance

// Helper: Format relative timestamp
function formatTimestamp(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins} min ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
  if (diffDays === 1) return 'Yesterday';

  // Format as date string
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined
  });
}

// Helper: Format absolute date-time (e.g. "Jan 5, 2025 · 14:32")
function formatAbsolute(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    + ' · '
    + date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

// Helper: Strip markdown syntax from text
function stripMarkdown(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')     // **bold**
    .replace(/\*(.+?)\*/g, '$1')         // *italic*
    .replace(/\[x\]/gi, '')              // [x] checkbox
    .replace(/\[ \]/g, '')               // [ ] checkbox
    .replace(/^- /gm, '')                // - bullet
    .replace(/^# /gm, '')                // # heading
    .trim();
}

// Helper: Generate note preview (first 80 chars, stripped)
function generatePreview(body) {
  if (!body) return '';
  const stripped = stripMarkdown(body);
  return stripped.length > 80 ? stripped.substring(0, 80) + '...' : stripped;
}

// Render Sidebar
export function renderSidebar() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;

  const collapsed = localStorage.getItem('notely-sidebar-collapsed') === 'true';
  if (collapsed) sidebar.classList.add('collapsed');
  else sidebar.classList.remove('collapsed');

  const chevron = collapsed ? 'chevron-right' : 'chevron-left';

  const html = `
    <div class="sidebar-top">
      <button class="sidebar-toggle" data-action="toggle-sidebar" title="${collapsed ? 'Expand sidebar' : 'Collapse sidebar'}">
        <i data-lucide="${chevron}" width="14" height="14"></i>
      </button>
    </div>

    <!-- Dashboard / Calendar -->
    <div class="sidebar-section">
      <div class="sidebar-items">
        <div class="sidebar-item ${store.currentView === 'dashboard' ? 'selected' : ''}" data-action="select-dashboard" title="Dashboard">
          <i data-lucide="layout-dashboard"></i>
          <span class="sidebar-item-text">Dashboard</span>
        </div>
        ${store.currentView === 'dashboard' ? `
        <div class="sidebar-item primary" data-action="toggle-add-widget-menu" title="Add widget">
          <i data-lucide="plus-square"></i>
          <span class="sidebar-item-text">Add widget</span>
        </div>` : ''}
        <div class="sidebar-item ${store.currentView === 'calendar' ? 'selected' : ''}" data-action="select-calendar" title="Calendar">
          <i data-lucide="calendar"></i>
          <span class="sidebar-item-text">Calendar</span>
        </div>
        <div class="sidebar-item ${store.currentView === 'advisor' ? 'selected' : ''}" data-action="select-advisor" title="${escapeHtml(store.settings?.advisor?.name || 'AI Advisor')}">
          <i data-lucide="bot"></i>
          <span class="sidebar-item-text">${escapeHtml(store.settings?.advisor?.name || 'AI Advisor')}</span>
        </div>
      </div>
    </div>

    <!-- Task Lists Section -->
    <div class="sidebar-section">
      <div class="sidebar-section-header">TASK LISTS</div>
      <div class="sidebar-items">
        ${store.taskLists.map(list => {
          const isSelected = store.currentTaskList === list.id && store.currentView === 'tasks';
          const isRenaming = store.renamingTaskListId === list.id;
          const typeIcon = list.type === 'priority' ? 'bell' : list.type === 'quantity' ? 'shopping-cart' : 'check-square';
          if (isRenaming) {
            return `
              <div class="sidebar-item selected" style="position:relative">
                <i data-lucide="${typeIcon}"></i>
                <input class="tasklist-rename-input" type="text" value="${escapeHtml(list.name)}"
                  data-list-id="${list.id}"
                  style="flex:1;border:none;outline:none;background:transparent;color:var(--color-text-strong);font-size:var(--text-sm);font-family:var(--font-sans);padding:0;min-width:0;"
                  autofocus />
              </div>`;
          }
          return `
            <div class="sidebar-item ${isSelected ? 'selected' : ''}"
                 data-action="select-tasklist" data-id="${list.id}" style="position:relative">
              <i data-lucide="${typeIcon}"></i>
              <span class="sidebar-item-text" ${isSelected ? `data-action="rename-task-list" data-id="${list.id}"` : ''} style="${isSelected ? 'cursor:text;' : ''}">${escapeHtml(list.name)}</span>
              <i class="sidebar-item-delete" data-lucide="trash-2" data-action="delete-task-list" data-id="${list.id}"
                 title="Delete list" style="width:14px;height:14px;color:var(--color-danger);opacity:0;transition:opacity 100ms;position:absolute;right:8px;cursor:pointer;"></i>
            </div>`;
        }).join('')}
        <div class="sidebar-item primary" data-action="new-task-list">
          <i data-lucide="plus"></i>
          <span class="sidebar-item-text">New Task List</span>
        </div>
      </div>
    </div>

    <!-- Notebooks Section -->
    <div class="sidebar-section">
      <div class="sidebar-section-header">NOTEBOOKS</div>
      <div class="sidebar-items">
        <!-- All Notes -->
        <div class="sidebar-item ${store.currentView !== 'dashboard' && store.currentNotebook === null && store.currentTag === null ? 'selected' : ''}" data-action="select-all-notes">
          <i data-lucide="file-text"></i>
          <span class="sidebar-item-text">All Notes</span>
        </div>

        <!-- Notebook List -->
        ${store.notebooks.map(notebook => {
          const isRenaming = store.renamingNotebookId === notebook.id;
          if (isRenaming) {
            return `
              <div class="sidebar-item selected" style="position: relative;">
                <i data-lucide="book"></i>
                <input
                  class="notebook-rename-input"
                  type="text"
                  value="${escapeHtml(notebook.name)}"
                  data-notebook-id="${notebook.id}"
                  style="flex:1; border:none; outline:none; background:transparent; color:var(--color-text-strong); font-size:var(--text-sm); font-family:var(--font-sans); padding:0; min-width:0;"
                  autofocus
                />
              </div>`;
          }
          return `
            <div class="sidebar-item ${store.currentNotebook === notebook.id ? 'selected' : ''}" data-action="select-notebook" data-id="${notebook.id}" style="position: relative;">
              <i data-lucide="book"></i>
              <span class="sidebar-item-text" ${store.currentNotebook === notebook.id ? `data-action="rename-notebook" data-id="${notebook.id}"` : ''} style="${store.currentNotebook === notebook.id ? 'cursor:text;' : ''}">${escapeHtml(notebook.name)}</span>
              <i class="sidebar-item-delete" data-lucide="trash-2" data-action="delete-notebook" data-id="${notebook.id}" title="Delete notebook" style="width: 14px; height: 14px; color: var(--color-danger); opacity: 0; transition: opacity 100ms; position: absolute; right: 8px; cursor: pointer;"></i>
            </div>`;
        }).join('')}

        <!-- New Notebook -->
        <div class="sidebar-item primary" data-action="new-notebook">
          <i data-lucide="plus"></i>
          <span class="sidebar-item-text">New Notebook</span>
        </div>
      </div>
    </div>

    <!-- Tags Section -->
    ${store.tags.length > 0 ? `
      <div class="sidebar-section">
        <div class="sidebar-section-header">TAGS</div>
        <div class="sidebar-items">
          ${store.tags.map(tag => `
            <div class="tag-sidebar-item ${store.currentTag === tag.id ? 'selected' : ''}" data-action="select-tag" data-id="${tag.id}">
              <i data-lucide="tag"></i>
              <span class="tag-sidebar-item-text">${escapeHtml(tag.name)}</span>
              ${tag.count > 0 ? `<span class="tag-sidebar-item-count">${tag.count}</span>` : ''}
              <button class="tag-sidebar-delete" data-action="delete-tag" data-id="${tag.id}" title="Delete tag"><i data-lucide="trash-2"></i></button>
            </div>
          `).join('')}
        </div>
      </div>
    ` : ''}

    <!-- Settings (footer) -->
    <div class="sidebar-footer">
      <div class="sidebar-item ${store.currentView === 'settings' ? 'selected' : ''}" data-action="select-settings" title="Settings">
        <i data-lucide="settings"></i>
        <span class="sidebar-item-text">Settings</span>
      </div>
    </div>
  `;

  sidebar.innerHTML = html;

  // Re-initialize Lucide icons
  if (window.lucide) {
    window.lucide.createIcons();
  }

  // Wire up inline notebook rename input if present
  const renameInput = sidebar.querySelector('.notebook-rename-input');
  if (renameInput) {
    renameInput.select();

    const commit = async () => {
      const { db } = await import('./db.js');
      const notebookId = parseInt(renameInput.dataset.notebookId);
      const name = renameInput.value.trim() || 'Untitled Notebook';
      try {
        await db.run('UPDATE notebooks SET name = ? WHERE id = ?', [name, notebookId]);
        const nb = store.notebooks.find(n => n.id === notebookId);
        if (nb) nb.name = name;
        store.notebooks.sort((a, b) => a.name.localeCompare(b.name));
      } catch (e) {
        console.error('Failed to rename notebook:', e);
      }
      store.renamingNotebookId = null;
      renderSidebar();
    };

    renameInput.addEventListener('blur', commit);
    renameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); renameInput.blur(); }
      if (e.key === 'Escape') {
        store.renamingNotebookId = null;
        renderSidebar();
      }
    });
  }

  // Wire up inline task list rename input if present
  const tlRenameInput = sidebar.querySelector('.tasklist-rename-input');
  if (tlRenameInput) {
    tlRenameInput.select();

    const commitTL = async () => {
      const { db } = await import('./db.js');
      const listId = parseInt(tlRenameInput.dataset.listId);
      const name = tlRenameInput.value.trim() || 'Untitled';
      try {
        await db.run('UPDATE task_lists SET name = ? WHERE id = ?', [name, listId]);
        const list = store.taskLists.find(l => l.id === listId);
        if (list) list.name = name;
      } catch (e) {
        console.error('Failed to rename task list:', e);
      }
      store.renamingTaskListId = null;
      renderSidebar();
      renderTasksView();
    };

    tlRenameInput.addEventListener('blur', commitTL);
    tlRenameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); tlRenameInput.blur(); }
      if (e.key === 'Escape') {
        store.renamingTaskListId = null;
        renderSidebar();
      }
    });
  }
}

// Shared task item HTML builder (used by dashboard and tasks view)
function buildTaskItemHTML(task, listType = 'basic') {
  let secondary = '';
  if (listType === 'priority') {
    secondary = `<div class="task-bells">${
      [5,4,3,2,1].map(n => `
        <button class="task-bell${n <= task.priority ? ' task-bell-active' : ''}"
                data-action="set-task-priority" data-id="${task.id}" data-priority="${n}"
                title="Priority ${n}">
          <i data-lucide="bell" width="10" height="10"></i>
        </button>`).join('')
    }</div>`;
  } else if (listType === 'quantity') {
    secondary = `<input class="task-qty" type="number" min="1" max="9999" value="${task.quantity ?? 1}"
                        data-action="set-task-quantity" data-id="${task.id}" title="Quantity" />`;
  }
  return `
  <div class="task-item${task.completed ? ' completed' : ''}" data-task-id="${task.id}">
    <button class="task-check" data-action="toggle-task" data-id="${task.id}" title="${task.completed ? 'Mark incomplete' : 'Mark complete'}">
      <i data-lucide="${task.completed ? 'check-circle-2' : 'circle'}"></i>
    </button>
    <span class="task-text">${escapeHtml(task.text)}</span>
    ${secondary}
    <button class="task-delete" data-action="delete-task" data-id="${task.id}" title="Delete task">
      <i data-lucide="x"></i>
    </button>
  </div>`;
}

// ── Dashboard widget content builders ────────────────────────────

const WIDGET_LABELS = { tasks: 'Tasks', calendar: 'Calendar', events: 'Events', recentNotes: 'Recent Notes', scratchpad: 'Scratch Pad' };
const WIDGET_ICONS  = { tasks: 'check-square', calendar: 'calendar', events: 'calendar-clock', recentNotes: 'file-text', scratchpad: 'edit-3' };

function getWidgetLabel(id) {
  if (id.startsWith('notebook-')) {
    const nb = store.notebooks.find(n => n.id === parseInt(id.slice(9)));
    return nb?.name || 'Notebook';
  }
  if (id.startsWith('note-')) {
    const note = store.notes.find(n => n.id === parseInt(id.slice(5)));
    return note?.title || 'Note';
  }
  if (id.startsWith('tasklist-')) {
    const list = store.taskLists.find(l => l.id === parseInt(id.slice(9)));
    return list?.name || 'Task List';
  }
  if (id === 'advisor') return store.settings?.advisor?.name || 'AI Advisor';
  return WIDGET_LABELS[id] || id;
}

function getWidgetIcon(id) {
  if (id.startsWith('notebook-')) return 'book';
  if (id.startsWith('note-'))     return 'file-text';
  if (id.startsWith('tasklist-')) {
    const list = store.taskLists.find(l => l.id === parseInt(id.slice(9)));
    return list?.type === 'priority' ? 'bell' : list?.type === 'quantity' ? 'shopping-cart' : 'check-square';
  }
  if (id === 'advisor') return 'bot';
  return WIDGET_ICONS[id] || 'layout-dashboard';
}

function buildTasksContent(ds) {
  const firstList = store.taskLists[0];
  if (!firstList) {
    return `<div class="dashboard-empty">No task lists yet</div>`;
  }
  const listType = firstList.type;
  const listTasks = store.tasks.filter(t => t.list_id === firstList.id);
  const pending   = listTasks.filter(t => !t.completed);
  const completed = listTasks.filter(t => t.completed);
  const maxH = `${ds.tasksMaxVisible * 38}px`;
  return `
    <div class="task-add-row dash-task-add-row">
      <input class="task-input" id="task-input" placeholder="Add…" maxlength="200" autocomplete="off">
      <button class="task-add-btn" data-action="add-task" title="Add task"><i data-lucide="plus"></i></button>
    </div>
    <div class="task-list dash-task-list" style="max-height:${maxH}; overflow-y:auto;">
      ${pending.map(t => buildTaskItemHTML(t, listType)).join('')}
      ${pending.length === 0 && completed.length === 0 ? '<div class="task-empty">No tasks yet</div>' : ''}
      ${completed.length > 0 ? `
        <div class="task-completed-heading">Done · ${completed.length}</div>
        ${completed.map(t => buildTaskItemHTML(t, listType)).join('')}` : ''}
    </div>`;
}

function buildRecentNotesContent(ds) {
  const notes = store.notes.slice(0, ds.recentNotesCount);
  if (!notes.length) return '<div class="dashboard-empty">No notes yet</div>';
  return `<div class="dash-notes-grid">
    ${notes.map(n => `
      <div class="dashboard-card" data-action="dashboard-select-note" data-id="${n.id}">
        <div class="dashboard-card-title">${escapeHtml(n.title || 'Untitled')}</div>
        ${n.notebook_name ? `<div class="dashboard-card-notebook">${escapeHtml(n.notebook_name)}</div>` : ''}
        <div class="dashboard-card-preview">${escapeHtml(generatePreview(n.body))}</div>
        <div class="dashboard-card-timestamp">${formatTimestamp(n.created_at)}</div>
      </div>`).join('')}
  </div>`;
}

function buildCalendarContent(ds) {
  return `<div class="dash-cal-section">${buildCalendarHTML()}</div>`;
}

function buildEventsContent(ds) {
  return buildThreeDayHTML(ds.calendarDaysAhead);
}

function buildNotebookWidgetContent(notebookId) {
  const notes = store.notes
    .filter(n => n.notebook_id === notebookId)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  if (!notes.length) return '<div class="dashboard-empty">No notes in this notebook</div>';
  return `<div class="dash-nb-list">
    ${notes.map(n => `
      <div class="dash-nb-item" data-action="dashboard-select-note" data-id="${n.id}">
        <div class="dash-nb-item-title">${escapeHtml(n.title || 'Untitled')}</div>
        <div class="dash-nb-item-meta">${formatTimestamp(n.created_at)}</div>
      </div>`).join('')}
  </div>`;
}

function buildNoteWidgetContent(noteId) {
  const note = store.notes.find(n => n.id === noteId);
  if (!note) return '<div class="dashboard-empty">Note not found</div>';
  const preview = note.body || '';
  return `
    <div class="dash-note-widget-body">
      <div class="dash-note-widget-preview">${escapeHtml(preview)}</div>
      <button class="dash-note-widget-open" data-action="dashboard-select-note" data-id="${note.id}">
        Open note
      </button>
    </div>`;
}

function buildTaskListWidgetContent(listId, ds) {
  const list = store.taskLists.find(l => l.id === listId);
  if (!list) return '<div class="dashboard-empty">Task list not found</div>';
  const listType = list.type;
  const listTasks = store.tasks.filter(t => t.list_id === listId);
  const pending   = listTasks.filter(t => !t.completed);
  const completed = listTasks.filter(t => t.completed);
  const maxH = `${(ds?.tasksMaxVisible ?? 8) * 38}px`;
  const placeholder = listType === 'quantity' ? 'Add an item…' : 'Add a task…';
  const qtyInput = listType === 'quantity'
    ? `<input class="task-input task-qty-add" id="task-qty-input" type="number" min="1" max="9999" value="1" title="Quantity" />`
    : '';
  return `
    <div data-widget-list-id="${listId}">
      <div class="task-add-row dash-task-add-row">
        <input class="task-input" id="task-input" placeholder="${placeholder}" maxlength="200" autocomplete="off">
        ${qtyInput}
        <button class="task-add-btn" data-action="add-task" title="Add"><i data-lucide="plus"></i></button>
      </div>
      <div class="task-list dash-task-list" style="max-height:${maxH}; overflow-y:auto;">
        ${pending.map(t => buildTaskItemHTML(t, listType)).join('')}
        ${pending.length === 0 && completed.length === 0 ? '<div class="task-empty">No items yet</div>' : ''}
        ${completed.length > 0 ? `
          <div class="task-completed-heading">Done · ${completed.length}</div>
          ${completed.map(t => buildTaskItemHTML(t, listType)).join('')}` : ''}
      </div>
    </div>`;
}

function buildAdvisorWidgetContent() {
  const msgs = store.advisorMessages.slice(-6); // last 6 messages
  const msgHTML = msgs.length
    ? msgs.map(m => `
        <div class="adv-msg adv-msg-${m.role}${m.working ? ' adv-msg-working' : ''}">
          <span class="adv-msg-text">${m.working ? escapeHtml(m.text) : renderMarkdown(m.text)}</span>
        </div>`).join('')
    : `<div class="adv-widget-empty">Ask me anything — I can manage your tasks, notes, and calendar.</div>`;
  const isLoading = store.advisorLoading;
  return `
    <div class="adv-widget" id="adv-widget">
      <div class="adv-widget-msgs" id="adv-widget-msgs">${msgHTML}${isLoading ? '<div class="adv-msg adv-msg-loading"><span class="adv-dots"><span>.</span><span>.</span><span>.</span></span></div>' : ''}</div>
      <div class="adv-widget-input-row">
        <input class="adv-widget-input" id="adv-widget-input" placeholder="Ask…" autocomplete="off" ${isLoading ? 'disabled' : ''} />
        <button class="adv-widget-send" data-action="advisor-widget-send" ${isLoading ? 'disabled' : ''} title="Send">
          <i data-lucide="send" width="13" height="13"></i>
        </button>
      </div>
    </div>`;
}

function buildWidgetContent(id, ds) {
  if (id.startsWith('notebook-'))  return buildNotebookWidgetContent(parseInt(id.slice(9)));
  if (id.startsWith('note-'))      return buildNoteWidgetContent(parseInt(id.slice(5)));
  if (id.startsWith('tasklist-'))  return buildTaskListWidgetContent(parseInt(id.slice(9)), ds);
  switch (id) {
    case 'tasks':       return buildTasksContent(ds);
    case 'recentNotes': return buildRecentNotesContent(ds);
    case 'calendar':    return buildCalendarContent(ds);
    case 'events':      return buildEventsContent(ds);
    case 'scratchpad':  return `<textarea class="dash-scratchpad" id="scratchpad" placeholder="Quick notes…"></textarea>`;
    case 'advisor':     return buildAdvisorWidgetContent();
    default: return '';
  }
}

// ── Render Dashboard ─────────────────────────────────────────────
export function renderDashboard() {
  const dashboardEl = document.getElementById('dashboard');
  if (!dashboardEl) return;

  document.getElementById('note-list').hidden = true;
  document.getElementById('editor').hidden    = true;
  dashboardEl.hidden = false;
  ['tasks-view','calendar-view','settings-view','advisor-view'].forEach(id =>
    document.getElementById(id)?.setAttribute('hidden',''));
  document.querySelector('.header')?.setAttribute('hidden', '');

  const ds = store.settings.dashboard;
  const layout = ds.layout; // [{id, x, y, w, h}]

  // Destroy previous grid instance so we can re-render cleanly
  if (_grid) { try { _grid.destroy(false); } catch {} _grid = null; }

  // Ensure every enabled widget has a layout entry (handles newly added widget types)
  const knownIds = new Set(layout.map(l => l.id));
  let layoutDirty = false;
  Object.keys(ds.widgets).forEach(wid => {
    if (ds.widgets[wid] !== false && !knownIds.has(wid)) {
      layout.push({ id: wid, x: 0, y: 999, w: 4, h: 4 });
      layoutDirty = true;
    }
  });
  if (layoutDirty) saveSettings(store.settings);

  // Only show enabled widgets
  const items = layout.filter(item => ds.widgets[item.id] !== false);

  const itemsHTML = items.map(item => {
    const isCustom = item.id.startsWith('notebook-') || item.id.startsWith('note-') || item.id.startsWith('tasklist-') || item.id === 'advisor';
    const closeBtn = isCustom
      ? `<button class="dash-widget-close" data-action="remove-widget" data-widget-id="${item.id}" title="Remove widget"><i data-lucide="x" width="12" height="12"></i></button>`
      : '';
    return `
    <div class="grid-stack-item" gs-id="${item.id}"
         gs-x="${item.x}" gs-y="${item.y}" gs-w="${item.w}" gs-h="${item.h}">
      <div class="grid-stack-item-content dash-widget" data-widget-id="${item.id}">
        <div class="dash-widget-header">
          <i data-lucide="${getWidgetIcon(item.id)}" width="13" height="13"></i>
          <span class="dash-widget-title">${escapeHtml(getWidgetLabel(item.id))}</span>
          <span class="dash-widget-grip"><i data-lucide="grip-horizontal" width="13" height="13"></i></span>
          ${closeBtn}
        </div>
        <div class="dash-widget-body">${buildWidgetContent(item.id, ds)}</div>
      </div>
    </div>`;
  }).join('');

  const emptyState = items.length === 0
    ? `<div class="dash-empty-state" style="padding:32px;color:var(--color-text-faint);text-align:center;">All widgets hidden — go to <strong>Settings</strong> to enable some.</div>`
    : '';

  dashboardEl.innerHTML = `
    <div class="dash-gs-wrap">
      <div class="grid-stack">${itemsHTML}</div>
      ${emptyState}
    </div>`;

  if (window.lucide) window.lucide.createIcons();

  // Initialize gridstack
  if (window.GridStack && items.length > 0) {
    _grid = window.GridStack.init({
      column: 12,
      cellHeight: 70,
      handle: '.dash-widget-header',
      animate: true,
      float: false,
      margin: 6,
    }, dashboardEl.querySelector('.grid-stack'));

    _grid.on('change', () => {
      const saved = _grid.save(false);
      store.settings.dashboard.layout = saved.map(n => ({
        id: n.id, x: n.x, y: n.y, w: n.w, h: n.h
      }));
      saveSettings(store.settings);
    });
  }

  // Restore scratchpad
  const scratch = document.getElementById('scratchpad');
  if (scratch) {
    try { scratch.value = localStorage.getItem('notely-scratchpad') || ''; } catch {}
    let debounce;
    scratch.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        try { localStorage.setItem('notely-scratchpad', scratch.value); } catch {}
      }, 400);
    });
  }
}

// Map tool names to a predicate that returns true for widget IDs they affect
const TOOL_WIDGET_MATCHER = {
  add_task:      id => id.startsWith('tasklist-'),
  complete_task: id => id.startsWith('tasklist-'),
  delete_task:   id => id.startsWith('tasklist-'),
  add_task_list: id => id.startsWith('tasklist-'),
  add_note:      id => id === 'recentNotes' || id.startsWith('notebook-') || id.startsWith('note-'),
  add_event:     id => id === 'events' || id === 'calendar',
};

export function refreshDashboardWidgets(toolName) {
  const dashboardEl = document.getElementById('dashboard');
  if (!dashboardEl || dashboardEl.hidden) return;
  const matcher = TOOL_WIDGET_MATCHER[toolName];
  if (!matcher) return;
  const ds = store.settings.dashboard;
  dashboardEl.querySelectorAll('.dash-widget').forEach(widget => {
    const wid = widget.dataset.widgetId;
    if (matcher(wid)) {
      const body = widget.querySelector('.dash-widget-body');
      if (body) {
        body.innerHTML = buildWidgetContent(wid, ds);
        if (window.lucide) window.lucide.createIcons({ nodes: Array.from(body.querySelectorAll('[data-lucide]')) });
      }
    }
  });
}

function buildDayScheduleHTML(dateStr) {
  const pad = n => String(n).padStart(2, '0');
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${pad(today.getMonth()+1)}-${pad(today.getDate())}`;
  const isToday = dateStr === todayStr;

  const d = new Date(dateStr + 'T00:00:00');
  const dateLabel = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  const dayEvents = store.events.filter(ev => ev.date === dateStr);
  const allDayEvents = dayEvents.filter(ev => !ev.time);
  const timedEvents = dayEvents.filter(ev => !!ev.time);

  const byHour = {};
  timedEvents.forEach(ev => {
    const h = parseInt(ev.time.split(':')[0]);
    (byHour[h] = byHour[h] || []).push(ev);
  });

  const allDayHTML = allDayEvents.length
    ? `<div class="ds-allday">
        <span class="ds-allday-label">All day</span>
        <div class="ds-allday-events">
          ${allDayEvents.map(ev => `
            <div class="ds-allday-event" title="${escapeHtml(ev.title)}">
              ${escapeHtml(ev.title)} <span class="ds-event-x" data-action="cal-delete-event" data-id="${ev.id}" title="Delete event">×</span>
            </div>`).join('')}
        </div>
       </div>`
    : '';

  const nowHour = today.getHours();
  const nowMin  = today.getMinutes();

  const rows = Array.from({ length: 24 }, (_, h) => {
    const evs = byHour[h] || [];
    const isCurrent = isToday && h === nowHour;
    const nowMarker = isCurrent
      ? `<div class="ds-now-line" style="top:${(nowMin / 60) * 100}%"></div>`
      : '';
    const evHTML = evs.map(ev => `
      <div class="ds-event" title="${escapeHtml(ev.title)}">
        <span class="ds-event-time">${escapeHtml(ev.time)}</span>
        <span class="ds-event-title">${escapeHtml(ev.title)}</span>
        <span class="ds-event-x" data-action="cal-delete-event" data-id="${ev.id}" title="Delete event">×</span>
      </div>`).join('');
    return `
      <div class="ds-hour${isCurrent ? ' ds-hour-current' : ''}" data-action="ds-hour-click" data-hour="${pad(h)}:00">
        <span class="ds-hour-label">${pad(h)}:00</span>
        <div class="ds-hour-body">
          ${nowMarker}${evHTML}
        </div>
      </div>`;
  }).join('');

  return `
    <div class="day-schedule">
      <div class="ds-header">${dateLabel}</div>
      ${allDayHTML}
      <div class="ds-hours" id="ds-hours-scroll">${rows}</div>
    </div>`;
}

function buildCalendarHTML() {
  const year  = store.calendarYear;
  const month = store.calendarMonth;
  const today = new Date();
  const pad   = n => String(n).padStart(2, '0');
  const todayStr = `${today.getFullYear()}-${pad(today.getMonth()+1)}-${pad(today.getDate())}`;
  const monthLabel = new Date(year, month).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDay    = (new Date(year, month, 1).getDay() + 6) % 7; // Mon=0

  // Index events by date
  const byDate = {};
  store.events.forEach(ev => { (byDate[ev.date] = byDate[ev.date] || []).push(ev); });

  const dayHeaders = ['Mo','Tu','We','Th','Fr','Sa','Su']
    .map(d => `<div class="cal-day-header">${d}</div>`).join('');

  const emptyCells = Array(firstDay).fill('<div class="cal-day cal-day-empty"></div>').join('');

  const dayCells = Array.from({ length: daysInMonth }, (_, i) => {
    const n       = i + 1;
    const dateStr = `${year}-${pad(month+1)}-${pad(n)}`;
    const isToday    = dateStr === todayStr;
    const isSelected = dateStr === store.calendarSelectedDate;
    const evs        = byDate[dateStr] || [];
    const evHTML = evs.map(ev => `
      <div class="cal-event" title="${escapeHtml(ev.title)}">
        ${ev.time ? `<span class="cal-event-time">${escapeHtml(ev.time)}</span>` : ''}
        <span class="cal-event-text">${escapeHtml(ev.title)}</span>
        <span class="cal-event-x" data-action="cal-delete-event" data-id="${ev.id}" title="Delete event">×</span>
      </div>`).join('');
    return `
      <div class="cal-day${isToday ? ' today' : ''}${isSelected ? ' selected' : ''}"
           data-action="cal-day-click" data-date="${dateStr}">
        <span class="cal-day-num">${n}</span>
        <div class="cal-events">${evHTML}</div>
      </div>`;
  }).join('');

  let addBar = '';
  if (store.calendarSelectedDate) {
    const d     = new Date(store.calendarSelectedDate + 'T00:00:00');
    const label = d.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' });
    addBar = `
      <div class="cal-add-bar">
        <span class="cal-add-label">${label}</span>
        <input class="cal-event-input" id="cal-event-input" placeholder="Event title…" maxlength="100" autocomplete="off" />
        <input class="cal-time-input" id="cal-event-time" type="time" title="Start time (optional)" />
        <button class="cal-add-btn" data-action="cal-add-event" title="Add"><i data-lucide="plus"></i></button>
      </div>`;
  }

  return `
    <div class="calendar">
      <div class="calendar-nav">
        <button class="cal-nav-btn" data-action="cal-prev"><i data-lucide="chevron-left"></i></button>
        <span class="calendar-month-label">${monthLabel}</span>
        <button class="cal-nav-btn" data-action="cal-next"><i data-lucide="chevron-right"></i></button>
      </div>
      <div class="calendar-grid">
        ${dayHeaders}
        ${emptyCells}
        ${dayCells}
      </div>
      ${addBar}
    </div>`;
}

function buildThreeDayHTML(daysAhead = store.settings?.dashboard?.calendarDaysAhead ?? 2) {
  const pad = n => String(n).padStart(2, '0');
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${pad(today.getMonth()+1)}-${pad(today.getDate())}`;
  const refStr = store.calendarSelectedDate || todayStr;

  const byDate = {};
  store.events.forEach(ev => { (byDate[ev.date] = byDate[ev.date] || []).push(ev); });

  const offsets = Array.from({ length: daysAhead + 1 }, (_, i) => i);
  const cols = offsets.map(offset => {
    const d = new Date(refStr + 'T00:00:00');
    d.setDate(d.getDate() + offset);
    const dateStr = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
    const isRef   = offset === 0;
    const isToday = dateStr === todayStr;
    const heading = isToday ? 'Today' : offset === 0 ? 'Selected' : offset === 1 ? 'Tomorrow' : 'In 2 days';
    const sub     = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const evs     = byDate[dateStr] || [];
    const evHTML  = evs.length
      ? evs.map(ev => `
          <div class="threeday-event" title="${escapeHtml(ev.title)}">
            ${ev.time ? `<span class="threeday-event-time">${escapeHtml(ev.time)}</span>` : ''}
            <span class="threeday-event-title">${escapeHtml(ev.title)}</span>
            <span class="threeday-event-x" data-action="cal-delete-event" data-id="${ev.id}" title="Delete event">×</span>
          </div>`).join('')
      : `<span class="threeday-empty">No events</span>`;
    return `
      <div class="threeday-col${isRef ? ' threeday-col-ref' : ''}">
        <div class="threeday-heading">${heading}</div>
        <div class="threeday-sub">${sub}</div>
        <div class="threeday-events">${evHTML}</div>
      </div>`;
  });

  return `<div class="threeday">${cols.join('')}</div>`;
}

// Restore the standard note-list + editor panels (called when leaving dashboard/tasks/calendar/settings)
function restoreHeaderSearch() {
  const ctx = document.getElementById('header-contextual');
  if (ctx) { ctx.innerHTML = ''; ctx.hidden = true; }
  const searchEl = document.querySelector('.search-input-wrapper');
  if (searchEl) searchEl.hidden = false;
  document.querySelector('.header')?.removeAttribute('hidden');
}

export function showNotePanels() {
  document.getElementById('dashboard')?.setAttribute('hidden', '');
  document.getElementById('tasks-view')?.setAttribute('hidden', '');
  document.getElementById('calendar-view')?.setAttribute('hidden', '');
  document.getElementById('settings-view')?.setAttribute('hidden', '');
  document.getElementById('advisor-view')?.setAttribute('hidden', '');
  const noteListEl = document.getElementById('note-list');
  const editorEl   = document.getElementById('editor');
  if (noteListEl) noteListEl.hidden = false;
  if (editorEl)   editorEl.hidden   = false;
  restoreHeaderSearch();
}

// Render Tasks full-page view
export function renderTasksView() {
  const tasksEl     = document.getElementById('tasks-view');
  const noteListEl  = document.getElementById('note-list');
  const editorEl    = document.getElementById('editor');
  const dashboardEl = document.getElementById('dashboard');
  const calendarEl  = document.getElementById('calendar-view');
  if (!tasksEl) return;

  noteListEl?.setAttribute('hidden', '');
  editorEl?.setAttribute('hidden', '');
  dashboardEl?.setAttribute('hidden', '');
  calendarEl?.setAttribute('hidden', '');
  document.getElementById('settings-view')?.setAttribute('hidden', '');
  document.getElementById('advisor-view')?.setAttribute('hidden', '');
  tasksEl.hidden = false;
  document.querySelector('.search-input-wrapper')?.setAttribute('hidden', '');
  document.getElementById('header-contextual')?.setAttribute('hidden', '');

  const list = store.taskLists.find(l => l.id === store.currentTaskList);
  const listType = list?.type || 'basic';
  const listName = list?.name || 'Tasks';
  const pending   = store.tasks.filter(t => !t.completed);
  const completed = store.tasks.filter(t => t.completed);
  const total     = store.tasks.length;
  const doneCount = completed.length;

  const qtyInputHTML = listType === 'quantity'
    ? `<input class="task-input task-qty-add" id="task-qty-input" type="number" min="1" max="9999" value="1" title="Quantity" />`
    : '';
  const placeholder = listType === 'quantity' ? 'Add an item…' : 'Add a task…';

  tasksEl.innerHTML = `
    <div class="feature-view-layout">
      <div class="feature-view-header">
        <div class="feature-view-title tl-title-editable" ${list ? `data-list-id="${list.id}" title="Click to rename"` : ''}
             style="${list ? 'cursor:text' : ''}">${escapeHtml(listName)}</div>
        ${total > 0 ? `<div class="feature-view-subtitle">${doneCount} of ${total} done</div>` : ''}
        ${list ? `<select class="tl-type-select" data-action="set-tasklist-type" data-list-id="${list.id}" title="List type">
          <option value="priority"${listType === 'priority' ? ' selected' : ''}>🔔 Priority</option>
          <option value="quantity"${listType === 'quantity' ? ' selected' : ''}>🛒 Quantity</option>
          <option value="basic"${listType === 'basic' ? ' selected' : ''}>☑ Basic</option>
        </select>` : ''}
      </div>
      <div class="task-add-row tasks-view-add-row">
        <input class="task-input" id="task-input" placeholder="${placeholder}" maxlength="200" autocomplete="off" />
        ${qtyInputHTML}
        <button class="task-add-btn" data-action="add-task" title="Add"><i data-lucide="plus"></i></button>
      </div>
      <div class="task-list tasks-view-list">
        ${pending.map(t => buildTaskItemHTML(t, listType)).join('')}
        ${pending.length === 0 && completed.length === 0
          ? '<div class="task-empty">No items yet — add one above</div>'
          : ''}
        ${completed.length > 0 ? `
          <div class="task-completed-heading">Done · ${completed.length}</div>
          ${completed.map(t => buildTaskItemHTML(t, listType)).join('')}
        ` : ''}
      </div>
    </div>`;

  if (window.lucide) window.lucide.createIcons();

  // Inline task list title rename
  if (list) {
    const titleEl = tasksEl.querySelector('.tl-title-editable');
    if (titleEl) {
      titleEl.addEventListener('click', () => {
        if (titleEl.contentEditable === 'true') return;
        const original = titleEl.textContent;
        let committed = false;
        titleEl.contentEditable = 'true';
        titleEl.focus();
        const range = document.createRange();
        range.selectNodeContents(titleEl);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);

        const commit = async () => {
          if (committed) return;
          committed = true;
          titleEl.contentEditable = 'false';
          const name = titleEl.textContent.trim() || original;
          titleEl.textContent = name;
          if (name !== original) {
            const { db } = await import('./db.js');
            try {
              await db.run('UPDATE task_lists SET name = ? WHERE id = ?', [name, list.id]);
              const tl = store.taskLists.find(l => l.id === list.id);
              if (tl) tl.name = name;
            } catch (e) { titleEl.textContent = original; }
            renderSidebar();
          }
        };

        titleEl.addEventListener('blur', commit, { once: true });
        titleEl.addEventListener('keydown', e => {
          if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); }
          if (e.key === 'Escape') { titleEl.textContent = original; titleEl.blur(); }
        });
      });
    }
  }
}

// Render Calendar full-page view
export function renderCalendarView() {
  const calendarEl  = document.getElementById('calendar-view');
  const noteListEl  = document.getElementById('note-list');
  const editorEl    = document.getElementById('editor');
  const dashboardEl = document.getElementById('dashboard');
  const tasksEl     = document.getElementById('tasks-view');
  if (!calendarEl) return;

  noteListEl?.setAttribute('hidden', '');
  editorEl?.setAttribute('hidden', '');
  dashboardEl?.setAttribute('hidden', '');
  tasksEl?.setAttribute('hidden', '');
  document.getElementById('settings-view')?.setAttribute('hidden', '');
  document.getElementById('advisor-view')?.setAttribute('hidden', '');
  calendarEl.hidden = false;
  document.querySelector('.search-input-wrapper')?.setAttribute('hidden', '');
  document.getElementById('header-contextual')?.setAttribute('hidden', '');

  const pad = n => String(n).padStart(2, '0');
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${pad(today.getMonth()+1)}-${pad(today.getDate())}`;
  const scheduleDate = store.calendarSelectedDate || todayStr;

  calendarEl.innerHTML = `
    <div class="feature-view-layout">
      <div class="feature-view-header">
        <div class="feature-view-title">Calendar</div>
      </div>
      <div class="calendar-view-body">
        <div class="calendar-view-left">
          ${buildCalendarHTML()}
        </div>
        <div class="calendar-view-right">
          ${buildDayScheduleHTML(scheduleDate)}
        </div>
      </div>
    </div>`;

  if (window.lucide) window.lucide.createIcons();

  // Scroll hours timeline so current hour is visible (if viewing today)
  setTimeout(() => {
    const currentHourEl = document.querySelector('.ds-hour-current');
    if (currentHourEl) {
      currentHourEl.scrollIntoView({ behavior: 'instant', block: 'center' });
    } else {
      // For non-today dates, scroll to 8am
      const hoursEl = document.getElementById('ds-hours-scroll');
      if (hoursEl) hoursEl.scrollTop = 48 * 8;
    }
    document.getElementById('cal-event-input')?.focus();
  }, 0);
}

// Render Settings full-page view
export function renderSettingsView() {
  const el = document.getElementById('settings-view');
  if (!el) return;

  ['note-list','editor','dashboard','tasks-view','calendar-view','advisor-view'].forEach(id =>
    document.getElementById(id)?.setAttribute('hidden', '')
  );
  el.hidden = false;
  restoreHeaderSearch();

  const s = store.settings;
  const d = s.dashboard;
  const w = d.widgets;
  const gc = s.googleCalendar;

  const checkbox = (key, label, checked, disabled = false) => `
    <label class="settings-checkbox-row${disabled ? ' settings-row-disabled' : ''}">
      <input type="checkbox" data-setting="dashboard.widgets.${key}" ${checked ? 'checked' : ''} />
      <span>${label}</span>
    </label>`;

  const radio = (name, value, label, checked, disabled = false) => `
    <label class="settings-radio-row">
      <input type="radio" name="${name}" value="${value}"
        data-setting="dashboard.${name}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} />
      <span>${label}</span>
    </label>`;

  el.innerHTML = `
    <div class="feature-view-layout">
      <div class="feature-view-header">
        <div class="feature-view-title">Settings</div>
      </div>

      <div class="settings-card">
        <div class="settings-card-title">Dashboard</div>

        <div class="settings-row">
          <div class="settings-row-label">Visible widgets</div>
          <div class="settings-row-control settings-checkbox-group">
            ${checkbox('recentNotes', 'Recent Notes', w.recentNotes)}
            ${checkbox('calendar',    'Calendar',     w.calendar)}
            ${checkbox('events',      'Events',       w.events)}
            ${checkbox('scratchpad',  'Scratch Pad',  w.scratchpad)}
          </div>
        </div>

        <div class="settings-row${!w.recentNotes ? ' settings-row-disabled' : ''}">
          <div class="settings-row-label">Recent notes to show</div>
          <div class="settings-row-control">
            <input type="number" class="settings-number-input" min="1" max="20"
              value="${d.recentNotesCount}" data-setting="dashboard.recentNotesCount"
              ${!w.recentNotes ? 'disabled' : ''} />
          </div>
        </div>

        <div class="settings-row${!w.events ? ' settings-row-disabled' : ''}">
          <div class="settings-row-label">Events widget — days to show</div>
          <div class="settings-row-control">
            <div class="settings-radio-group">
              ${radio('calendarDaysAhead', '0', 'Selected day only',    d.calendarDaysAhead === 0, !w.events)}
              ${radio('calendarDaysAhead', '1', 'Selected + 1 day',     d.calendarDaysAhead === 1, !w.events)}
              ${radio('calendarDaysAhead', '2', 'Selected + 2 days',    d.calendarDaysAhead === 2, !w.events)}
            </div>
          </div>
        </div>

        <div class="settings-row${!w.tasks ? ' settings-row-disabled' : ''}">
          <div class="settings-row-label">Max tasks before scroll</div>
          <div class="settings-row-control">
            <input type="number" class="settings-number-input" min="3" max="50"
              value="${d.tasksMaxVisible}" data-setting="dashboard.tasksMaxVisible"
              ${!w.tasks ? 'disabled' : ''} />
          </div>
        </div>

        <div class="settings-row${!w.tasks ? ' settings-row-disabled' : ''}">
          <div class="settings-row-label">Task sort order</div>
          <div class="settings-row-control">
            <div class="settings-radio-group">
              ${radio('tasksSortOrder', 'desc', 'Most urgent first (highest bells)', d.tasksSortOrder === 'desc', !w.tasks)}
              ${radio('tasksSortOrder', 'asc',  'Least urgent first',                d.tasksSortOrder === 'asc',  !w.tasks)}
            </div>
          </div>
        </div>
      </div>

      <div class="settings-card">
        <div class="settings-card-title">Appearance</div>

        <div class="settings-row">
          <div class="settings-row-label">Theme</div>
          <div class="settings-row-control">
            <button class="theme-toggle" data-action="toggle-theme" title="Toggle theme">
              <i data-lucide="${document.documentElement.dataset.theme === 'dark' ? 'moon' : 'sun'}"></i>
            </button>
            <span class="settings-row-hint">${document.documentElement.dataset.theme === 'dark' ? 'Dark' : 'Light'} mode</span>
          </div>
        </div>

        <div class="settings-row">
          <div class="settings-row-label">Background color</div>
          <div class="settings-row-control settings-color-row">
            <input type="color" class="settings-color-input" id="appearance-bg-color"
              value="${s.appearance?.bgColor || '#FAF9F7'}" />
            <button class="settings-link-btn" id="appearance-bg-reset">Reset</button>
          </div>
        </div>

        <div class="settings-row">
          <div class="settings-row-label">Accent color</div>
          <div class="settings-row-control settings-color-row">
            <input type="color" class="settings-color-input" id="appearance-accent-color"
              value="${s.appearance?.accentColor || '#2D7D6F'}" />
            <button class="settings-link-btn" id="appearance-accent-reset">Reset</button>
          </div>
        </div>

        <div class="settings-row">
          <div class="settings-row-label">Background image</div>
          <div class="settings-row-control" id="appearance-image-control">
            ${s.appearance?.bgImageSet
              ? `<div class="settings-bg-preview">
                   <img class="settings-bg-thumb" src="${localStorage.getItem('notely-bg-image') || ''}" />
                   <button class="settings-link-btn settings-link-btn-danger" id="appearance-img-remove">Remove</button>
                 </div>`
              : `<button class="settings-upload-btn" id="appearance-img-pick">
                   <i data-lucide="upload" width="13" height="13"></i> Upload image
                 </button>
                 <input type="file" id="appearance-img-upload" accept="image/*" style="display:none">`
            }
          </div>
        </div>
      </div>

      <div class="settings-card">
        <div class="settings-card-title">AI Advisor</div>
        <div class="settings-row">
          <div class="settings-row-label">Name</div>
          <div class="settings-row-control">
            <input type="text" class="settings-text-input" id="advisor-name-input"
              value="${escapeHtml(s.advisor?.name || 'AI Advisor')}" placeholder="AI Advisor" maxlength="40" />
          </div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">Provider</div>
          <div class="settings-row-control">
            <select class="settings-select" id="advisor-provider-input">
              <option value="auto"      ${(s.advisor?.provider||'auto') === 'auto'      ? 'selected' : ''}>Auto-detect from key</option>
              <option value="anthropic" ${s.advisor?.provider === 'anthropic' ? 'selected' : ''}>Anthropic (Claude Haiku)</option>
              <option value="openai"    ${s.advisor?.provider === 'openai'    ? 'selected' : ''}>OpenAI (GPT-4o mini)</option>
              <option value="gemini"    ${s.advisor?.provider === 'gemini'    ? 'selected' : ''}>Google Gemini 3.6 Flash</option>
            </select>
          </div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">API Key</div>
          <div class="settings-row-control">
            <input type="password" class="settings-text-input" id="advisor-key-input"
              value="${escapeHtml(s.advisor?.apiKey || '')}" placeholder="sk-ant-… / sk-… / AIza…" autocomplete="off" />
            <span class="settings-row-hint">Stored locally in your browser only — never sent anywhere else</span>
          </div>
        </div>
        <div class="settings-row settings-row-tall">
          <div class="settings-row-label">Your context</div>
          <div class="settings-row-control">
            <textarea class="settings-textarea" id="advisor-prompt-input"
              placeholder="Tell the advisor about yourself: your goals, preferences, what you use Notely for…" rows="5">${escapeHtml(s.advisor?.systemPrompt || '')}</textarea>
          </div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">History limit</div>
          <div class="settings-row-control">
            <input type="number" class="settings-text-input" id="advisor-history-input"
              value="${s.advisor?.historyMax ?? 20}" min="1" max="100" style="width:80px" />
            <span class="settings-row-hint">Max saved conversations (default 20)</span>
          </div>
        </div>
      </div>

      <div class="settings-card">
        <div class="settings-card-title">Google Calendar</div>
        ${gc.connected ? `
          <div class="settings-row">
            <div class="settings-row-label">
              <span>Connected${gc.accountEmail ? ` as ${escapeHtml(gc.accountEmail)}` : ''}</span>
              <span class="settings-row-hint">${gc.lastSyncAt ? `Last synced ${new Date(gc.lastSyncAt).toLocaleString()}` : 'Not synced yet'}</span>
            </div>
            <div class="settings-row-control">
              <button class="settings-link-btn" data-action="google-sync-now">Sync now</button>
              <button class="settings-link-btn settings-link-btn-danger" data-action="google-disconnect">Disconnect</button>
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-row-label">Calendars to show in Notely</div>
            <div class="settings-row-control settings-checkbox-group">
              ${gc.calendars.length ? gc.calendars.map(c => `
                <label class="settings-checkbox-row">
                  <input type="checkbox" data-action="toggle-google-calendar" data-id="${escapeHtml(c.id)}" ${c.selected ? 'checked' : ''} />
                  <span>${escapeHtml(c.summary)}</span>
                </label>`).join('') : '<span class="settings-row-hint">No calendars found</span>'}
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-row-label">Add new Notely events to</div>
            <div class="settings-row-control">
              <select class="settings-select" data-setting="googleCalendar.writeCalendarId">
                ${gc.calendars.map(c => `<option value="${escapeHtml(c.id)}" ${gc.writeCalendarId === c.id ? 'selected' : ''}>${escapeHtml(c.summary)}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-row-label">Sync enabled</div>
            <div class="settings-row-control">
              <label class="settings-checkbox-row">
                <input type="checkbox" data-setting="googleCalendar.syncEnabled" ${gc.syncEnabled ? 'checked' : ''} />
                <span>Keep syncing automatically</span>
              </label>
            </div>
          </div>
        ` : `
          <div class="settings-row">
            <div class="settings-row-label">
              <span>Not connected</span>
              <span class="settings-row-hint">Show Google Calendar events in Notely, and push events you add here back to Google.</span>
            </div>
            <div class="settings-row-control">
              <button class="settings-upload-btn" data-action="google-connect">Connect Google Calendar</button>
            </div>
          </div>
        `}
      </div>

      <div class="settings-card settings-card-danger">
        <div class="settings-card-title">Danger Zone</div>
        <div class="settings-row">
          <div class="settings-row-label">
            <span>Clear all data</span>
            <span class="settings-row-hint">Permanently deletes all notes, notebooks, tasks, task lists, and events. Settings are kept.</span>
          </div>
          <div class="settings-row-control">
            <button class="btn btn-danger" data-action="clear-all-data">Clear all data</button>
          </div>
        </div>
      </div>
    </div>`;

  if (window.lucide) window.lucide.createIcons();

  // ── Appearance settings ──────────────────────────────────────────
  function saveAppearance() {
    saveSettings(store.settings);
    applyAppearance(store.settings.appearance);
  }

  document.getElementById('appearance-bg-color')?.addEventListener('input', e => {
    if (!store.settings.appearance) store.settings.appearance = {};
    store.settings.appearance.bgColor = e.target.value;
    saveAppearance();
  });
  document.getElementById('appearance-bg-reset')?.addEventListener('click', () => {
    if (!store.settings.appearance) store.settings.appearance = {};
    store.settings.appearance.bgColor = '';
    saveAppearance();
    document.getElementById('appearance-bg-color').value = '#FAF9F7';
  });

  document.getElementById('appearance-accent-color')?.addEventListener('input', e => {
    if (!store.settings.appearance) store.settings.appearance = {};
    store.settings.appearance.accentColor = e.target.value;
    saveAppearance();
  });
  document.getElementById('appearance-accent-reset')?.addEventListener('click', () => {
    if (!store.settings.appearance) store.settings.appearance = {};
    store.settings.appearance.accentColor = '';
    saveAppearance();
    document.getElementById('appearance-accent-color').value = '#2D7D6F';
  });

  function setImageCtrl(dataUrl) {
    const ctrl = document.getElementById('appearance-image-control');
    if (!ctrl) return;
    if (dataUrl) {
      ctrl.innerHTML = `<div class="settings-bg-preview">
        <img class="settings-bg-thumb" src="${dataUrl}" />
        <button class="settings-link-btn settings-link-btn-danger" id="appearance-img-remove">Remove</button>
      </div>`;
      document.getElementById('appearance-img-remove')?.addEventListener('click', removeImage);
    } else {
      ctrl.innerHTML = `<button class="settings-upload-btn" id="appearance-img-pick">
        <i data-lucide="upload" width="13" height="13"></i> Upload image
      </button>
      <input type="file" id="appearance-img-upload" accept="image/*" style="display:none">`;
      if (window.lucide) window.lucide.createIcons({ nodes: Array.from(ctrl.querySelectorAll('[data-lucide]')) });
      attachUploadHandlers();
    }
  }

  function attachUploadHandlers() {
    document.getElementById('appearance-img-pick')?.addEventListener('click', () => {
      document.getElementById('appearance-img-upload')?.click();
    });
    document.getElementById('appearance-img-upload')?.addEventListener('change', onImageUpload);
  }

  function onImageUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const dataUrl = ev.target.result;
      try { localStorage.setItem('notely-bg-image', dataUrl); } catch {
        alert('Image too large to store. Try a smaller file (under 4 MB).');
        return;
      }
      if (!store.settings.appearance) store.settings.appearance = {};
      store.settings.appearance.bgImageSet = true;
      saveAppearance();
      setImageCtrl(dataUrl);
    };
    reader.readAsDataURL(file);
  }

  function removeImage() {
    localStorage.removeItem('notely-bg-image');
    if (!store.settings.appearance) store.settings.appearance = {};
    store.settings.appearance.bgImageSet = false;
    saveAppearance();
    setImageCtrl(null);
  }

  attachUploadHandlers();
  document.getElementById('appearance-img-remove')?.addEventListener('click', removeImage);

  // Wire advisor settings inputs (save on blur/change)
  function saveAdvisorField(field, value) {
    if (!s.advisor) s.advisor = {};
    s.advisor[field] = value;
    // Keep store.settings in sync so the advisor view reads the live value
    if (!store.settings.advisor) store.settings.advisor = {};
    store.settings.advisor[field] = value;
    try { localStorage.setItem('notely-settings', JSON.stringify(s)); } catch {}
    // Update sidebar label live
    document.querySelectorAll('[data-action="select-advisor"] .sidebar-item-text')
      .forEach(el => { el.textContent = s.advisor.name || 'AI Advisor'; });
  }
  document.getElementById('advisor-name-input')
    ?.addEventListener('change', e => saveAdvisorField('name', e.target.value.trim() || 'AI Advisor'));
  document.getElementById('advisor-provider-input')
    ?.addEventListener('change', e => saveAdvisorField('provider', e.target.value));
  document.getElementById('advisor-key-input')
    ?.addEventListener('change', e => saveAdvisorField('apiKey', e.target.value.trim()));
  document.getElementById('advisor-key-input')
    ?.addEventListener('blur', e => saveAdvisorField('apiKey', e.target.value.trim()));
  document.getElementById('advisor-prompt-input')
    ?.addEventListener('change', e => saveAdvisorField('systemPrompt', e.target.value));
  document.getElementById('advisor-history-input')
    ?.addEventListener('change', e => saveAdvisorField('historyMax', Math.max(1, parseInt(e.target.value) || 20)));
}

// Simple markdown → HTML renderer (safe, no external deps)
function renderMarkdown(text) {
  if (!text) return '';
  // Escape HTML first
  let html = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Bold and italic
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // Code spans
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bullet lists: convert consecutive "- " lines into <ul>
  html = html.replace(/((?:^|\n)- .+)+/g, match => {
    const items = match.trim().split('\n').map(l => `<li>${l.replace(/^- /, '')}</li>`).join('');
    return `<ul>${items}</ul>`;
  });
  // Line breaks
  html = html.replace(/\n/g, '<br>');
  return html;
}

// Render AI Advisor full view
export function renderAdvisorView() {
  const el = document.getElementById('advisor-view');
  if (!el) return;

  ['note-list','editor','dashboard','tasks-view','calendar-view','settings-view'].forEach(id =>
    document.getElementById(id)?.setAttribute('hidden', ''));
  el.hidden = false;
  restoreHeaderSearch();

  const name = escapeHtml(store.settings?.advisor?.name || 'AI Advisor');
  const hasKey = !!(store.settings?.advisor?.apiKey);
  const currentId = getCurrentConvId();
  const allConvs = getAllConversations();

  // Conversation history sidebar
  const convItems = allConvs.map(c => {
    const isActive = c.id === currentId && store.advisorMessages.length > 0;
    const title = escapeHtml(c.title || 'Conversation');
    const d = new Date(c.updatedAt || c.createdAt);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
    const dateLabel = sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toDateString() === yesterday.toDateString() ? 'Yesterday'
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    return `<div class="adv-conv-item${isActive ? ' adv-conv-active' : ''}"
                 data-action="advisor-load-conv" data-conv-id="${escapeHtml(c.id)}">
              <div class="adv-conv-title">${title}</div>
              <div class="adv-conv-date">${dateLabel}</div>
            </div>`;
  }).join('');

  const messagesHTML = store.advisorMessages.length
    ? store.advisorMessages.map(m => `
        <div class="adv-msg adv-msg-${m.role}${m.working ? ' adv-msg-working' : ''}">
          ${m.role === 'assistant' && !m.working
            ? `<div class="adv-msg-avatar"><i data-lucide="bot" width="14" height="14"></i></div>`
            : ''}
          <div class="adv-msg-bubble">${m.working ? escapeHtml(m.text) : renderMarkdown(m.text)}</div>
        </div>`).join('')
    : `<div class="adv-empty">
        <i data-lucide="bot" style="width:32px;height:32px;color:var(--color-primary);margin-bottom:12px"></i>
        <div class="adv-empty-title">${name}</div>
        <div class="adv-empty-sub">${hasKey ? 'Ask me anything — I can create tasks, add events, and search your notes.' : 'Add your API key in Settings to get started.'}</div>
      </div>`;

  el.innerHTML = `
    <div class="advisor-layout">
      <div class="adv-sidebar">
        <button class="adv-new-btn" data-action="advisor-new-conv">
          <i data-lucide="plus" width="14" height="14"></i> New chat
        </button>
        <div class="adv-conv-list">
          ${convItems || '<div class="adv-conv-empty">No past conversations</div>'}
        </div>
      </div>
      <div class="adv-main">
        <div class="feature-view-header">
          <div class="feature-view-title">${name}</div>
        </div>
        <div class="adv-chat">
          <div class="adv-messages" id="adv-messages">
            ${messagesHTML}
            ${store.advisorLoading ? '<div class="adv-msg adv-msg-assistant"><div class="adv-msg-avatar"><i data-lucide="bot" width="14" height="14"></i></div><div class="adv-msg-bubble adv-msg-thinking"><span class="adv-dots"><span>.</span><span>.</span><span>.</span></span></div></div>' : ''}
          </div>
          <div class="adv-input-row">
            <textarea class="adv-input" id="adv-input" rows="1"
              placeholder="${hasKey ? 'Ask anything…' : 'Configure API key in Settings first'}"
              ${hasKey ? '' : 'disabled'}
              autocomplete="off"></textarea>
            <button class="adv-send-btn" data-action="advisor-send"
              ${hasKey && !store.advisorLoading ? '' : 'disabled'}
              title="Send (Enter)">
              <i data-lucide="send" width="16" height="16"></i>
            </button>
          </div>
        </div>
      </div>
    </div>`;

  if (window.lucide) window.lucide.createIcons();

  const msgsEl = document.getElementById('adv-messages');
  if (msgsEl) msgsEl.scrollTop = msgsEl.scrollHeight;

  const input = document.getElementById('adv-input');
  if (input) {
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        document.querySelector('[data-action="advisor-send"]')?.click();
      }
    });
    if (!store.advisorLoading) input.focus();
  }
}

// Render Note List
export function renderNoteList(searchQuery = null) {
  const noteListElement = document.getElementById('note-list');
  if (!noteListElement) return;

  // Determine context label
  let contextLabel = 'All Notes';
  if (searchQuery) {
    contextLabel = `Search results for "${searchQuery}"`;
  } else if (store.currentView === 'dashboard') {
    contextLabel = 'Recent Notes';
  } else if (store.currentNotebook) {
    const notebook = store.notebooks.find(n => n.id === store.currentNotebook);
    contextLabel = notebook ? notebook.name : 'All Notes';
  } else if (store.currentTag) {
    const tag = store.tags.find(t => t.id === store.currentTag);
    contextLabel = tag ? `#${tag.name}` : 'All Notes';
  }

  const noteCount = store.notes.length;

  // Determine empty state message
  let emptyStateHTML = '';
  if (searchQuery) {
    emptyStateHTML = `
      <div class="empty-state">
        <i class="empty-state-icon" data-lucide="search"></i>
        <div class="empty-state-heading">No results for "${escapeHtml(searchQuery)}"</div>
        <div class="empty-state-subtext">Try different keywords</div>
      </div>
    `;
  } else {
    emptyStateHTML = `
      <div class="empty-state">
        <i class="empty-state-icon" data-lucide="file-text"></i>
        <div class="empty-state-heading">No notes yet</div>
        <div class="empty-state-subtext">Create your first note to get started</div>
      </div>
    `;
  }

  const isDashboard = store.currentView === 'dashboard';
  const isNotebookContext = !searchQuery && !isDashboard && store.currentNotebook !== null && store.currentTag === null;
  const currentNotebookData = isNotebookContext ? store.notebooks.find(n => n.id === store.currentNotebook) : null;

  const html = `
    <div class="note-list-header">
      <div class="note-list-header-row">
        <div class="note-list-context"${isNotebookContext ? ' data-editable="true" data-action="rename-notebook-inline" data-id="' + store.currentNotebook + '"' : ''}>${escapeHtml(contextLabel)}</div>
        ${isNotebookContext ? `<button class="note-list-delete-notebook" data-action="delete-notebook-header" data-id="${store.currentNotebook}" title="Delete notebook"><i data-lucide="trash-2"></i></button>` : ''}
      </div>
      <div class="note-list-count">
        ${noteCount} note${noteCount === 1 ? '' : 's'}${isNotebookContext && currentNotebookData?.created_at ? ` · Created ${formatAbsolute(currentNotebookData.created_at)}` : ''}
      </div>
    </div>
    <div class="note-list-scroll">
      ${noteCount > 0 ? store.notes.map((note, index) => {
        const notebookName = isDashboard && note.notebook_name ? escapeHtml(note.notebook_name) : null;
        return `
        <div class="note-card ${store.currentNote === note.id ? 'selected' : ''}" data-action="select-note" data-id="${note.id}" data-index="${index}" tabindex="0">
          <div class="note-card-title">${escapeHtml(note.title || 'Untitled')}</div>
          ${notebookName ? `<div class="note-card-notebook">${notebookName}</div>` : ''}
          <div class="note-card-preview">${escapeHtml(generatePreview(note.body))}</div>
          <div class="note-card-timestamp">${formatTimestamp(note.created_at)}</div>
        </div>`;
      }).join('') : emptyStateHTML}
    </div>
    <button class="fab" data-action="new-note" title="New note (Ctrl+N)">
      <i data-lucide="plus"></i>
    </button>
  `;

  noteListElement.innerHTML = html;

  // Re-initialize Lucide icons
  if (window.lucide) {
    window.lucide.createIcons();
  }

  // Inline notebook rename from list header
  if (isNotebookContext) {
    const ctx = noteListElement.querySelector('[data-action="rename-notebook-inline"]');
    if (ctx) {
      ctx.addEventListener('click', () => {
        if (ctx.contentEditable === 'true') return;
        const notebookId = parseInt(ctx.dataset.id);
        const originalName = ctx.textContent;
        let committed = false;

        ctx.contentEditable = 'true';
        ctx.focus();

        // Place cursor at end, no selection
        const range = document.createRange();
        range.selectNodeContents(ctx);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);

        const commit = async () => {
          if (committed) return;
          committed = true;
          ctx.contentEditable = 'false';
          const { db } = await import('./db.js');
          const name = ctx.textContent.trim() || 'Untitled Notebook';
          try {
            await db.run('UPDATE notebooks SET name = ? WHERE id = ?', [name, notebookId]);
            const nb = store.notebooks.find(n => n.id === notebookId);
            if (nb) nb.name = name;
          } catch (e) { console.error('Rename failed:', e); }
          renderSidebar();
          renderNoteList(searchQuery);
        };

        const cancel = () => {
          if (committed) return;
          committed = true;
          ctx.contentEditable = 'false';
          ctx.textContent = originalName;
        };

        ctx.addEventListener('blur', commit, { once: true });
        ctx.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); ctx.blur(); }
          if (e.key === 'Escape') { ctx.textContent = originalName; ctx.blur(); cancel(); }
        });
      });
    }
  }
}

// Render Editor
export async function renderEditor(note) {
  const editorElement = document.getElementById('editor');
  if (!editorElement) return;

  if (!note) {
    // Empty state
    const html = `
      <div class="editor-empty">
        <div class="empty-state">
          <i class="empty-state-icon" data-lucide="file-text"></i>
          <div class="empty-state-heading">Select a note or create a new one</div>
        </div>
      </div>
    `;
    editorElement.innerHTML = html;

    // Re-initialize Lucide icons
    if (window.lucide) {
      window.lucide.createIcons();
    }
    return;
  }

  // Fetch tags for this note
  const noteTags = await fetchNoteTags(note.id);

  // Editor with note (now fully interactive)
  const html = `
    <div style="display: flex; flex-direction: column; height: 100%; gap: var(--space-lg);">
      <!-- Title -->
      <input
        type="text"
        class="editor-title"
        value="${escapeHtml(note.title || '')}"
        placeholder="Untitled"
        style="font-size: var(--text-xl); font-weight: 600; color: var(--color-text-strong); border: none; outline: none; background: transparent; padding: 0;"
      />

      <!-- Note meta -->
      <div class="editor-meta">
        <span title="Created">Created ${formatAbsolute(note.created_at)}</span>
        <span class="editor-meta-sep">·</span>
        <span title="Last edited">Edited ${formatTimestamp(note.updated_at)}</span>
      </div>

      <!-- Tag bar -->
      <div class="editor-tags" style="display: flex; gap: var(--space-sm); flex-wrap: wrap; align-items: center; min-height: 24px;">
        ${renderTagBar(noteTags)}
      </div>

      <!-- Toolbar -->
      <div class="editor-toolbar">
        <!-- Write / Preview tabs -->
        <div class="editor-tabs">
          <button class="editor-tab active" data-action="tab-write">Write</button>
          <button class="editor-tab" data-action="tab-preview">Preview</button>
        </div>

        <!-- Formatting buttons (write mode only) -->
        <div class="editor-format-buttons">
          <button class="toolbar-button" title="Bold (Ctrl+B)" data-action="bold">
            <i data-lucide="bold"></i>
          </button>
          <button class="toolbar-button" title="Italic (Ctrl+I)" data-action="italic">
            <i data-lucide="italic"></i>
          </button>
          <button class="toolbar-button" title="Bullet List" data-action="bullet">
            <i data-lucide="list"></i>
          </button>
          <button class="toolbar-button" title="Checkbox" data-action="checkbox">
            <i data-lucide="check-square"></i>
          </button>
        </div>

        <div style="flex: 1;"></div>
        <button class="toolbar-button" title="Delete note" data-action="delete-note" style="color: var(--color-danger);">
          <i data-lucide="trash-2"></i>
        </button>
      </div>

      <!-- Editor content area (single pane, toggled by tabs) -->
      <div class="editor-pane-wrap">
        <textarea
          class="editor-textarea"
          placeholder="Start typing..."
        >${escapeHtml(note.body || '')}</textarea>

        <div class="editor-preview" hidden></div>
      </div>

      <!-- Attachment tray -->
      <div class="attachment-tray"></div>

      <!-- Status indicator -->
      <div class="status-indicator">Saved</div>
    </div>
  `;

  editorElement.innerHTML = html;

  // Re-initialize Lucide icons
  if (window.lucide) {
    window.lucide.createIcons();
  }

  // Set up tag bar event listeners
  setupTagBarListeners();
}

/**
 * Render tag bar HTML
 */
function renderTagBar(tags) {
  const tagPills = tags.map(tag => `
    <div class="tag-pill removable" data-tag-id="${tag.id}">
      ${escapeHtml(tag.name)}
      <i class="tag-pill-remove" data-lucide="x" data-action="remove-tag" data-tag-id="${tag.id}"></i>
    </div>
  `).join('');

  return `
    ${tagPills}
    <button class="tag-pill clickable" data-action="add-tag" style="border: 1px dashed var(--color-border); cursor: pointer;">
      + Add tag
    </button>
  `;
}

/**
 * Fetch tags for a specific note
 */
async function fetchNoteTags(noteId) {
  const { db } = await import('./db.js');
  return await db.all(
    'SELECT t.* FROM tags t JOIN note_tags nt ON t.id = nt.tag_id WHERE nt.note_id = ? ORDER BY t.name',
    [noteId]
  );
}

/**
 * Set up tag bar event listeners
 */
function setupTagBarListeners() {
  const tagBar = document.querySelector('.editor-tags');
  if (!tagBar) return;

  tagBar.addEventListener('click', async (event) => {
    const target = event.target.closest('[data-action]');
    if (!target) return;

    const action = target.dataset.action;

    if (action === 'add-tag') {
      openInlineTagInput(target);
    } else if (action === 'remove-tag') {
      const tagId = parseInt(target.dataset.tagId);
      await handleRemoveTag(tagId);
    }
  });
}

/**
 * Replace the "+ Add tag" button with an inline input in the tag bar
 */
function openInlineTagInput(addBtn) {
  if (addBtn.dataset.editing) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'tag name';
  input.className = 'tag-pill tag-pill-input';
  input.maxLength = 32;

  addBtn.replaceWith(input);
  input.focus();

  let committed = false;

  const commit = async () => {
    if (committed) return;
    committed = true;
    const name = input.value.trim();
    // Restore button
    input.replaceWith(addBtn);
    if (name) await handleAddTag(name);
  };

  const cancel = () => {
    if (committed) return;
    committed = true;
    input.replaceWith(addBtn);
  };

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = ''; cancel(); }
  });
}

/**
 * Save a tag by name to the current note
 */
async function handleAddTag(tagName) {
  const { db } = await import('./db.js');

  try {
    let tag = await db.get('SELECT id FROM tags WHERE name = ?', [tagName]);

    if (!tag) {
      const result = await db.run('INSERT INTO tags (name) VALUES (?)', [tagName]);
      tag = { id: result.lastInsertId };

      store.tags = await db.all(`
        SELECT t.*, COUNT(nt.note_id) as count
        FROM tags t
        LEFT JOIN note_tags nt ON t.id = nt.tag_id
        GROUP BY t.id
        ORDER BY t.name
      `);

      renderSidebar();
    }

    await db.run(
      'INSERT OR IGNORE INTO note_tags (note_id, tag_id) VALUES (?, ?)',
      [store.currentNote, tag.id]
    );

    const note = await db.get('SELECT * FROM notes WHERE id = ?', [store.currentNote]);
    await renderEditor(note);

    const { initEditor, refreshAttachmentTray } = await import('./editor.js');
    initEditor();
    await refreshAttachmentTray();
  } catch (error) {
    console.error('Failed to add tag:', error);
    showToast('Could not add tag.', 'error');
  }
}

/**
 * Handle removing a tag from the current note
 */
async function handleRemoveTag(tagId) {
  const { db } = await import('./db.js');

  try {
    // Remove tag from note_tags junction
    await db.run(
      'DELETE FROM note_tags WHERE note_id = ? AND tag_id = ?',
      [store.currentNote, tagId]
    );

    // Refresh tags in store (counts may have changed)
    store.tags = await db.all(`
      SELECT t.*, COUNT(nt.note_id) as count
      FROM tags t
      LEFT JOIN note_tags nt ON t.id = nt.tag_id
      GROUP BY t.id
      ORDER BY t.name
    `);

    // Re-render sidebar
    renderSidebar();

    // Refresh editor to remove tag pill
    const note = await db.get('SELECT * FROM notes WHERE id = ?', [store.currentNote]);
    await renderEditor(note);

    // Re-initialize editor
    const { initEditor, refreshAttachmentTray } = await import('./editor.js');
    initEditor();
    await refreshAttachmentTray();

    console.log('Tag removed:', tagId);
  } catch (error) {
    console.error('Failed to remove tag:', error);
    alert('Failed to remove tag');
  }
}

// Helper: Escape HTML to prevent XSS
export function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Show confirmation dialog
 * @param {string} title - Dialog title
 * @param {string} message - Dialog message
 * @param {Function} onConfirm - Function to call on confirm
 * @returns {Promise} Resolves on confirm, rejects on cancel
 */
export function showConfirmDialog(title, message, onConfirm) {
  return new Promise((resolve, reject) => {
    const dialogContainer = document.getElementById('dialog-container');
    if (!dialogContainer) {
      reject(new Error('Dialog container not found'));
      return;
    }

    // Create dialog HTML
    const dialogHTML = `
      <div class="dialog-overlay">
        <div class="confirm-dialog">
          <div class="confirm-dialog-title">${escapeHtml(title)}</div>
          <div class="confirm-dialog-body">${escapeHtml(message)}</div>
          <div class="confirm-dialog-buttons">
            <button class="confirm-dialog-button cancel" data-action="cancel">Cancel</button>
            <button class="confirm-dialog-button danger" data-action="confirm">Confirm</button>
          </div>
        </div>
      </div>
    `;

    dialogContainer.innerHTML = dialogHTML;

    const overlay = dialogContainer.querySelector('.dialog-overlay');
    const cancelBtn = dialogContainer.querySelector('[data-action="cancel"]');
    const confirmBtn = dialogContainer.querySelector('[data-action="confirm"]');

    // Focus confirm button
    setTimeout(() => confirmBtn?.focus(), 50);

    // Close dialog
    const closeDialog = (confirmed) => {
      dialogContainer.innerHTML = '';
      if (confirmed) {
        if (onConfirm) onConfirm();
        resolve();
      } else {
        reject(new Error('Cancelled'));
      }
    };

    // Event listeners
    cancelBtn?.addEventListener('click', () => closeDialog(false));
    confirmBtn?.addEventListener('click', () => closeDialog(true));
    overlay?.addEventListener('click', (e) => {
      if (e.target === overlay) closeDialog(false);
    });

    // Keyboard handlers
    const handleKeydown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeDialog(false);
        document.removeEventListener('keydown', handleKeydown);
      } else if (e.key === 'Enter' && document.activeElement === confirmBtn) {
        e.preventDefault();
        closeDialog(true);
        document.removeEventListener('keydown', handleKeydown);
      }
    };

    document.addEventListener('keydown', handleKeydown);
  });
}

/**
 * Show toast notification
 * @param {string} message - Toast message
 * @param {string} type - Toast type ('error', 'success', 'info')
 */
export function showToast(message, type = 'error') {
  const toastContainer = document.getElementById('toast-container');
  if (!toastContainer) return;

  // Create toast element
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.dataset.type = type;
  toast.textContent = message;

  // Apply styles based on type
  if (type === 'error') {
    toast.style.background = 'var(--color-danger-muted)';
    toast.style.color = 'var(--color-danger)';
    toast.style.borderLeft = '3px solid var(--color-danger)';
  }

  // Common styles
  toast.style.padding = 'var(--space-md) var(--space-lg)';
  toast.style.borderRadius = 'var(--radius-md)';
  toast.style.boxShadow = 'var(--shadow-mid)';
  toast.style.fontSize = 'var(--text-sm)';
  toast.style.cursor = 'pointer';
  toast.style.animation = 'toastSlideUp 200ms ease-out';
  toast.style.minWidth = '300px';
  toast.style.maxWidth = '500px';

  // Add to container
  toastContainer.appendChild(toast);

  // Auto-dismiss after 5s
  const autoDismissTimer = setTimeout(() => {
    dismissToast(toast);
  }, 5000);

  // Click to dismiss
  toast.addEventListener('click', () => {
    clearTimeout(autoDismissTimer);
    dismissToast(toast);
  });
}

/**
 * Dismiss a toast
 * @param {HTMLElement} toast - Toast element to dismiss
 */
function dismissToast(toast) {
  toast.style.animation = 'toastFadeOut 100ms ease-out';
  setTimeout(() => {
    toast.remove();
  }, 100);
}
