// Settings persistence - Notely

const DEFAULTS = {
  dashboard: {
    widgets: { recentNotes: true, tasks: true, calendar: true, scratchpad: true },
    recentNotesCount: 8,
    calendarDaysAhead: 2,   // 0 = selected day only, 1 = +1, 2 = +2
    tasksMaxVisible: 10,
    tasksSortOrder: 'desc'  // 'desc' = most bells first (default), 'asc' = fewest first
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
    return raw ? deepMerge(base, JSON.parse(raw)) : base;
  } catch {
    return JSON.parse(JSON.stringify(DEFAULTS));
  }
}

export function saveSettings(s) {
  try { localStorage.setItem('notely-settings', JSON.stringify(s)); } catch {}
}
