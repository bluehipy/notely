// Client-side state management - Notely

import { loadSettings } from './settings.js';

export const store = {
  // Data arrays
  notebooks: [],
  notes: [],
  tags: [],
  taskLists: [],
  tasks: [],
  events: [],

  // Calendar navigation state
  calendarYear: new Date().getFullYear(),
  calendarMonth: new Date().getMonth(),
  calendarSelectedDate: null,

  // Current selections
  currentNotebook: null,  // ID of selected notebook, or null for "All Notes"
  currentNote: null,      // ID of selected note
  currentTag: null,       // ID of selected tag
  currentTaskList: null,  // ID of selected task list

  // Search state
  searchQuery: '',

  // Inline rename state
  renamingNotebookId: null,
  renamingTaskListId: null,

  // Active view: 'notes' | 'dashboard' | 'tasks' | 'calendar' | 'settings'
  currentView: 'notes',

  // User settings (persisted to localStorage)
  settings: loadSettings()
};
