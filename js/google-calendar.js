// Google Calendar — the live source of truth for Notely's calendar/events.
//
// OAuth via chrome.identity + direct Calendar API v3 calls. There is no local
// mirror: every read is a fresh fetch, every write goes straight to Google.
// Runs entirely in the tab context (never in background.js).

import { store } from './store.js';
import { saveSettings, defaultGoogleCalendarSettings } from './settings.js';

const API_BASE = 'https://www.googleapis.com/calendar/v3';
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

function pad(n) { return String(n).padStart(2, '0'); }

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dayDelta(dateA, dateB) {
  return Math.round((new Date(dateB + 'T00:00:00') - new Date(dateA + 'T00:00:00')) / 86400000);
}

function addOneHour(time) {
  const [h, m] = time.split(':').map(Number);
  const total = (h * 60 + m + 60) % (24 * 60);
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

function isoLocalDate(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function isoLocalTime(iso) {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

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
    const err = new Error('Event no longer exists');
    err.status = 410;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`Google Calendar API ${res.status}: ${await res.text().catch(() => '')}`);
    err.status = res.status;
    throw err;
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
    selected: !!c.primary
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

  store.settings.googleCalendar = defaultGoogleCalendarSettings();
  saveSettings(store.settings);
  store.events = [];
}

// ── Event colors & recurrence presets (UI-facing constants) ─────────

export const EVENT_COLORS = [
  { id: '1',  name: 'Lavender',  hex: '#7986cb' },
  { id: '2',  name: 'Sage',      hex: '#33b679' },
  { id: '3',  name: 'Grape',     hex: '#8e24aa' },
  { id: '4',  name: 'Flamingo',  hex: '#e67c73' },
  { id: '5',  name: 'Banana',    hex: '#f6c026' },
  { id: '6',  name: 'Tangerine', hex: '#f5511d' },
  { id: '7',  name: 'Peacock',   hex: '#039be5' },
  { id: '8',  name: 'Graphite',  hex: '#616161' },
  { id: '9',  name: 'Blueberry', hex: '#3f51b5' },
  { id: '10', name: 'Basil',     hex: '#0b8043' },
  { id: '11', name: 'Tomato',    hex: '#d60000' }
];

const RRULE_MAP = {
  daily:   'RRULE:FREQ=DAILY',
  weekly:  'RRULE:FREQ=WEEKLY',
  monthly: 'RRULE:FREQ=MONTHLY',
  yearly:  'RRULE:FREQ=YEARLY'
};
const RRULE_TO_PRESET = Object.fromEntries(Object.entries(RRULE_MAP).map(([k, v]) => [v, k]));

export const RECURRENCE_PRESETS = [
  { key: 'none',    label: 'Does not repeat' },
  { key: 'daily',   label: 'Daily' },
  { key: 'weekly',  label: 'Weekly' },
  { key: 'monthly', label: 'Monthly' },
  { key: 'yearly',  label: 'Yearly' }
];

function derivePreset(recurrenceArr) {
  if (!recurrenceArr || !recurrenceArr.length) return 'none';
  return RRULE_TO_PRESET[recurrenceArr[0]] || 'custom';
}

// ── Google Event <-> Notely event shape ──────────────────────────────

function toStoreEvent(gev, calendarId) {
  const allDay = !!gev.start?.date;
  return {
    id: gev.id,
    calendarId,
    title: gev.summary || '(untitled)',
    description: gev.description || '',
    colorId: gev.colorId || null,
    recurringEventId: gev.recurringEventId || null,
    recurrencePreset: derivePreset(gev.recurrence),
    allDay,
    date:    allDay ? gev.start.date : isoLocalDate(gev.start.dateTime),
    time:    allDay ? null : isoLocalTime(gev.start.dateTime),
    endDate: allDay ? addDays(gev.end.date, -1) : isoLocalDate(gev.end.dateTime),
    endTime: allDay ? null : isoLocalTime(gev.end.dateTime),
    timeZone: gev.start?.timeZone || gev.end?.timeZone || null
  };
}

// data: { title, description, allDay, date, time, endDate, endTime, colorId, recurrence, timeZone }
function buildGoogleEventBody(data, { includeRecurrence = true } = {}) {
  const body = { summary: data.title || '(untitled)' };
  if (data.description !== undefined) body.description = data.description || '';
  if (data.colorId) body.colorId = String(data.colorId);

  const startDate = data.date;
  const endDate = data.endDate || data.date;

  if (data.allDay) {
    body.start = { date: startDate };
    body.end = { date: addDays(endDate, 1) }; // Google's all-day end date is exclusive
  } else {
    const tz = data.timeZone || TZ;
    const time = data.time || '09:00';
    const endTime = data.endTime || addOneHour(time);
    body.start = { dateTime: `${startDate}T${time}:00`, timeZone: tz };
    body.end = { dateTime: `${endDate}T${endTime}:00`, timeZone: tz };
  }

  if (includeRecurrence) {
    body.recurrence = data.recurrence && data.recurrence !== 'none' ? [RRULE_MAP[data.recurrence]] : [];
  }
  return body;
}

// ── Read ──────────────────────────────────────────────────────────

async function fetchCalendarEvents(calendarId, timeMin, timeMax) {
  const params = new URLSearchParams({
    timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', showDeleted: 'false', maxResults: '250'
  });
  let items = [];
  let pageToken = '';
  do {
    if (pageToken) params.set('pageToken', pageToken); else params.delete('pageToken');
    const page = await apiFetch(`/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`);
    items = items.concat(page.items || []);
    pageToken = page.nextPageToken || '';
  } while (pageToken);
  return items.map((gev) => toStoreEvent(gev, calendarId));
}

export async function fetchEvents(timeMin, timeMax) {
  const gcal = store.settings.googleCalendar;
  const cals = (gcal.calendars || []).filter((c) => c.selected);
  const results = await Promise.all(cals.map((cal) => fetchCalendarEvents(cal.id, timeMin, timeMax)));
  const merged = results.flat();
  merged.sort((a, b) =>
    a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || '') || a.id.localeCompare(b.id)
  );
  return merged;
}

export async function getEvent(calendarId, eventId) {
  const gev = await apiFetch(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
  return toStoreEvent(gev, calendarId);
}

// ── Write ─────────────────────────────────────────────────────────

export async function createEvent(calendarId, data) {
  const body = buildGoogleEventBody(data, { includeRecurrence: true });
  const created = await apiFetch(`/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: 'POST',
    body: JSON.stringify(body)
  });
  return toStoreEvent(created, calendarId);
}

// options: { scope: 'this'|'all', recurringEventId, originalDate }
// For scope 'all' on a recurring occurrence, if the user didn't change the date
// (data.date === originalDate) we preserve the series' own anchor date and only
// splice in the new time-of-day — otherwise a time-only edit would silently
// shift which day/weekday the whole series recurs on.
export async function updateEvent(calendarId, eventId, data, { scope = 'this', recurringEventId = null, originalDate = null } = {}) {
  let targetId = eventId;
  let payload = data;

  if (scope === 'all' && recurringEventId) {
    targetId = recurringEventId;
    if (originalDate && data.date === originalDate) {
      const master = await apiFetch(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(recurringEventId)}`);
      const anchorDate = master.start?.date || isoLocalDate(master.start?.dateTime);
      const delta = dayDelta(data.date, data.endDate || data.date);
      payload = { ...data, date: anchorDate, endDate: addDays(anchorDate, delta) };
    }
  }

  const body = buildGoogleEventBody(payload, { includeRecurrence: scope === 'all' });
  const updated = await apiFetch(
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(targetId)}`,
    { method: 'PATCH', body: JSON.stringify(body) }
  );
  return toStoreEvent(updated, calendarId);
}

// options: { scope: 'this'|'all', recurringEventId }
export async function deleteEvent(calendarId, eventId, { scope = 'this', recurringEventId = null } = {}) {
  const targetId = (scope === 'all' && recurringEventId) ? recurringEventId : eventId;
  try {
    await apiFetch(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(targetId)}`, { method: 'DELETE' });
  } catch (err) {
    if (err.status === 410) return; // Google already considers it gone — that's the outcome we wanted
    throw err;
  }
}

// ── Refresh orchestrator ─────────────────────────────────────────────
// No syncToken, no local reconciliation — every refresh is a fresh fetch of
// the current fetch window. Stale-while-revalidate: keep whatever's already
// in store.events visible and only flip store.eventsLoading when there's
// nothing to show yet. A request-generation counter drops out-of-order
// responses from overlapping refreshes (e.g. rapid month-nav clicks).

let _fetchGen = 0;

function computeFetchWindow() {
  const y = store.calendarYear, m = store.calendarMonth;
  const start = new Date(y, m - 1, 1);
  const end = new Date(y, m + 2, 0, 23, 59, 59);
  return { timeMin: start.toISOString(), timeMax: end.toISOString() };
}

export async function refreshEvents({ background = false } = {}) {
  if (!isActive()) {
    store.events = [];
    store.eventsLoading = false;
    store.eventsError = null;
    return;
  }

  const gen = ++_fetchGen;
  if (!background || store.events.length === 0) store.eventsLoading = true;

  const { timeMin, timeMax } = computeFetchWindow();
  try {
    const events = await fetchEvents(timeMin, timeMax);
    if (gen !== _fetchGen) return; // superseded by a newer request
    store.events = events;
    store.eventsLoading = false;
    store.eventsError = null;
  } catch (err) {
    if (gen !== _fetchGen) return;
    store.eventsLoading = false;
    store.eventsError = err.message || 'Failed to load events';
    console.warn('[google-calendar] refresh failed:', err.message);
  }
}
