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

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export function applyAppearance(appearance) {
  const root = document.documentElement;

  if (appearance.bgColor) {
    root.style.setProperty('--color-bg', appearance.bgColor);
  } else {
    root.style.removeProperty('--color-bg');
  }

  if (appearance.accentColor) {
    const c = appearance.accentColor;
    root.style.setProperty('--color-primary',       c);
    root.style.setProperty('--color-primary-hover', c);
    root.style.setProperty('--color-checked',       c);
    root.style.setProperty('--color-primary-muted', hexToRgba(c, 0.12));
    root.style.setProperty('--color-selection',     hexToRgba(c, 0.20));
  } else {
    ['--color-primary','--color-primary-hover','--color-checked',
     '--color-primary-muted','--color-selection'].forEach(p => root.style.removeProperty(p));
  }

  const imgData = appearance.bgImageSet
    ? (localStorage.getItem('notely-bg-image') || '')
    : '';
  if (imgData) {
    document.body.style.backgroundImage    = `url("${imgData}")`;
    document.body.style.backgroundSize     = 'cover';
    document.body.style.backgroundPosition = 'center';
    document.body.style.backgroundAttachment = 'fixed';
    root.classList.add('has-bg-image');
  } else {
    document.body.style.backgroundImage = '';
    root.classList.remove('has-bg-image');
  }
}
