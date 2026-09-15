// Settings persistence - Notely

const DEFAULTS = {
  appearance: {
    bgColor: '',      // '' = use theme default
    accentColor: '',  // '' = use theme default
    bgImageSet: false // true when an image is stored in localStorage key notely-bg-image
  },
  advisor: {
    name: 'AI Advisor',
    provider: 'auto',
    apiKey: '',
    systemPrompt: '',
    historyMax: 20
  },
  dashboard: {
    widgets: { recentNotes: true, calendar: true, events: true, scratchpad: true },
    recentNotesCount: 8,
    calendarDaysAhead: 2,
    tasksMaxVisible: 10,
    tasksSortOrder: 'desc',
    // Gridstack layout: array of {id, x, y, w, h} in 12-column units
    layout: [
      { id: 'calendar',    x: 0, y: 0, w: 4, h: 5 },
      { id: 'events',      x: 4, y: 0, w: 4, h: 5 },
      { id: 'scratchpad',  x: 8, y: 0, w: 4, h: 5 },
      { id: 'recentNotes', x: 0, y: 5, w: 12, h: 5 },
    ]
  },
  googleCalendar: {
    connected: false,
    accountEmail: '',
    calendars: [],        // [{ id, summary, selected, syncToken }]
    writeCalendarId: '',  // which calendar new Notely events push to
    syncEnabled: true,
    lastSyncAt: null
  }
};

function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (source[key] !== null && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      target[key] = deepMerge(target[key] ?? {}, source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem('notely-settings');
    const base = JSON.parse(JSON.stringify(DEFAULTS));
    if (!raw) return base;
    const parsed = JSON.parse(raw);
    // Migrate: reset layout if it's not the gridstack array format
    if (parsed.dashboard?.grid) delete parsed.dashboard.grid;
    if (parsed.dashboard?.layout && !Array.isArray(parsed.dashboard.layout)) {
      delete parsed.dashboard.layout;
    }
    // Migrate: remove legacy built-in tasks widget from saved layouts
    if (Array.isArray(parsed.dashboard?.layout)) {
      parsed.dashboard.layout = parsed.dashboard.layout.filter(l => l.id !== 'tasks');
    }
    // Migrate: remove tasks from saved widgets object
    if (parsed.dashboard?.widgets?.tasks !== undefined) {
      delete parsed.dashboard.widgets.tasks;
    }
    return deepMerge(base, parsed);
  } catch {
    return JSON.parse(JSON.stringify(DEFAULTS));
  }
}

export function saveSettings(s) {
  try { localStorage.setItem('notely-settings', JSON.stringify(s)); } catch {}
}

export function saveAdvisorSettings(advisor) {
  try {
    const raw = localStorage.getItem('notely-settings');
    const s = raw ? JSON.parse(raw) : {};
    s.advisor = advisor;
    localStorage.setItem('notely-settings', JSON.stringify(s));
  } catch {}
}

export function defaultGoogleCalendarSettings() {
  return JSON.parse(JSON.stringify(DEFAULTS.googleCalendar));
}
