// Google Calendar sync — OAuth (chrome.identity) + Calendar API v3 + push/pull engine.
//
// Runs entirely in the tab context (never in background.js): the SQLite/OPFS
// database is only reachable from here, via js/db.js -> js/db.worker.js.

import { store } from './store.js';
import { db } from './db.js';
import { saveSettings, defaultGoogleCalendarSettings } from './settings.js';

const API_BASE = 'https://www.googleapis.com/calendar/v3';
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

function pad(n) { return String(n).padStart(2, '0'); }

export function isActive() {
  const g = store.settings.googleCalendar;
  return !!(g && g.connected && g.syncEnabled);
}

function getToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      const err = chrome.runtime.lastError;
      if (err || !token) { reject(new Error(err?.message || 'No auth token')); return; }
      resolve(token);
    });
  });
}

function removeCachedToken(token) {
  return new Promise((resolve) => chrome.identity.removeCachedAuthToken({ token }, () => resolve()));
}

function getProfileEmail() {
  return new Promise((resolve) => {
    chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' }, (info) => resolve(info?.email || ''));
  });
}

async function apiFetch(path, options = {}, _retried = false) {
  const token = await getToken(false);
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {})
    }
  });

  if (res.status === 401 && !_retried) {
    await removeCachedToken(token);
    return apiFetch(path, options, true);
  }
  if (res.status === 410) {
    const err = new Error('Sync token expired');
    err.status = 410;
    throw err;
  }
  if (!res.ok) {
    throw new Error(`Google Calendar API ${res.status}: ${await res.text().catch(() => '')}`);
  }
  return res.status === 204 ? null : res.json();
}

// ── Connect / disconnect ────────────────────────────────────────────

export async function connect() {
  await getToken(true); // interactive — prompts the Google consent screen
  const list = await apiFetch('/users/me/calendarList');
  const calendars = (list.items || []).map((c) => ({
    id: c.id,
    summary: c.summary,
    selected: !!c.primary,
    syncToken: ''
  }));
  const primary = calendars.find((c) => c.selected) || calendars[0];

  const gcal = store.settings.googleCalendar;
  gcal.connected = true;
  gcal.accountEmail = await getProfileEmail();
  gcal.calendars = calendars;
  gcal.writeCalendarId = primary?.id || '';
  gcal.syncEnabled = true;
  saveSettings(store.settings);
  return calendars;
}

export async function disconnect() {
  try {
    const token = await getToken(false);
    await removeCachedToken(token);
  } catch { /* no cached token to remove */ }

  await db.run('UPDATE events SET google_event_id = NULL, google_calendar_id = NULL WHERE google_event_id IS NOT NULL');
  store.events = store.events.map((e) => ({ ...e, google_event_id: null, google_calendar_id: null }));
  store.settings.googleCalendar = defaultGoogleCalendarSettings();
  saveSettings(store.settings);
}

// ── Push: local change -> Google ────────────────────────────────────

function toGoogleEvent(ev) {
  if (ev.time) {
    const start = new Date(`${ev.date}T${ev.time}:00`);
    const end = new Date(start.getTime() + 60 * 60 * 1000); // Notely has no duration field — default 1h
    const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
    return {
      summary: ev.title,
      start: { dateTime: iso(start), timeZone: TZ },
      end: { dateTime: iso(end), timeZone: TZ }
    };
  }
  const endDate = new Date(`${ev.date}T00:00:00`);
  endDate.setDate(endDate.getDate() + 1); // Google's all-day end date is exclusive
  return {
    summary: ev.title,
    start: { date: ev.date },
    end: { date: `${endDate.getFullYear()}-${pad(endDate.getMonth() + 1)}-${pad(endDate.getDate())}` }
  };
}

export async function pushCreate(event) {
  const gcal = store.settings.googleCalendar;
  if (!isActive() || !gcal.writeCalendarId || !event) return;
  try {
    const created = await apiFetch(`/calendars/${encodeURIComponent(gcal.writeCalendarId)}/events`, {
      method: 'POST',
      body: JSON.stringify(toGoogleEvent(event))
    });
    const now = new Date().toISOString();
    await db.run(
      'UPDATE events SET google_event_id = ?, google_calendar_id = ?, synced_at = ? WHERE id = ?',
      [created.id, gcal.writeCalendarId, now, event.id]
    );
    event.google_event_id = created.id;
    event.google_calendar_id = gcal.writeCalendarId;
    event.synced_at = now;
  } catch (err) {
    // Best-effort: an unsynced row (google_event_id IS NULL) is retried by the next syncNow()
    console.warn('[google-calendar] push create failed, will retry on next sync:', err.message);
  }
}

export async function pushDelete(event) {
  if (!isActive() || !event?.google_event_id) return;
  try {
    const calendarId = event.google_calendar_id || store.settings.googleCalendar.writeCalendarId;
    await apiFetch(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(event.google_event_id)}`, {
      method: 'DELETE'
    });
  } catch (err) {
    console.warn('[google-calendar] push delete failed:', err.message);
  }
}

// ── Pull: Google -> local ───────────────────────────────────────────

function parseGoogleEvent(gev) {
  if (gev.start?.date) return { title: gev.summary || '(untitled)', date: gev.start.date, time: null };
  if (gev.start?.dateTime) {
    const dt = new Date(gev.start.dateTime);
    return {
      title: gev.summary || '(untitled)',
      date: `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`,
      time: `${pad(dt.getHours())}:${pad(dt.getMinutes())}`
    };
  }
  return null;
}

async function pullCalendar(cal) {
  const params = new URLSearchParams({ showDeleted: 'true', singleEvents: 'true' });
  if (cal.syncToken) params.set('syncToken', cal.syncToken);
  else params.set('timeMin', new Date().toISOString());

  let items = [];
  let pageToken = '';
  let nextSyncToken = cal.syncToken;
  try {
    do {
      if (pageToken) params.set('pageToken', pageToken); else params.delete('pageToken');
      const page = await apiFetch(`/calendars/${encodeURIComponent(cal.id)}/events?${params.toString()}`);
      items = items.concat(page.items || []);
      pageToken = page.nextPageToken || '';
      if (page.nextSyncToken) nextSyncToken = page.nextSyncToken;
    } while (pageToken);
  } catch (err) {
    if (err.status === 410) {
      // Expired/invalid sync token: drop local tracking for this calendar and rebuild from scratch
      await db.run('DELETE FROM events WHERE google_calendar_id = ?', [cal.id]);
      cal.syncToken = '';
      return pullCalendar(cal);
    }
    console.warn('[google-calendar] pull failed for', cal.id, err.message);
    return;
  }

  for (const gev of items) {
    if (gev.status === 'cancelled') {
      await db.run('DELETE FROM events WHERE google_event_id = ?', [gev.id]);
      continue;
    }
    const parsed = parseGoogleEvent(gev);
    if (!parsed) continue;
    const now = new Date().toISOString();
    const existing = await db.get('SELECT id FROM events WHERE google_event_id = ?', [gev.id]);
    if (existing) {
      await db.run(
        'UPDATE events SET title = ?, date = ?, time = ?, updated_at = ?, synced_at = ? WHERE id = ?',
        [parsed.title, parsed.date, parsed.time, now, now, existing.id]
      );
    } else {
      await db.run(
        `INSERT INTO events (title, date, time, google_event_id, google_calendar_id, source, synced_at)
         VALUES (?, ?, ?, ?, ?, 'google', ?)`,
        [parsed.title, parsed.date, parsed.time, gev.id, cal.id, now]
      );
    }
  }
  cal.syncToken = nextSyncToken || cal.syncToken;
}

// ── Orchestrator ─────────────────────────────────────────────────────

export async function syncNow() {
  if (!isActive()) return;
  const gcal = store.settings.googleCalendar;

  // Retry-push any local events that haven't made it to Google yet (offline resilience)
  const unsynced = await db.all("SELECT * FROM events WHERE google_event_id IS NULL AND source = 'local'");
  for (const ev of unsynced) await pushCreate(ev);

  for (const cal of gcal.calendars.filter((c) => c.selected)) {
    await pullCalendar(cal);
  }

  store.events = await db.all('SELECT * FROM events ORDER BY date ASC, time ASC, id ASC');
  gcal.lastSyncAt = new Date().toISOString();
  saveSettings(store.settings);
}
