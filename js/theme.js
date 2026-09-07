// Theme management - Notely

export function initTheme() {
  // Check localStorage first
  const savedTheme = localStorage.getItem('theme');

  if (savedTheme) {
    document.documentElement.dataset.theme = savedTheme;
  } else {
    // Fall back to system preference
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = prefersDark ? 'dark' : 'light';
  }
}

export function toggleTheme() {
  const current = document.documentElement.dataset.theme;
  const newTheme = current === 'light' ? 'dark' : 'light';

  document.documentElement.dataset.theme = newTheme;
  localStorage.setItem('theme', newTheme);

  return newTheme;
}

export function getCurrentTheme() {
  return document.documentElement.dataset.theme || 'light';
}
