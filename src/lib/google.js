// Chamadas à Google Calendar API. A autenticação acontece toda no Rust.
const { invoke } = window.__TAURI__.core;

const enc = encodeURIComponent;

export function api(account, method, path, { query, body } = {}) {
  const q = query ? Object.entries(query).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]) : null;
  return invoke('google_request', { account, method, path, query: q, body: body ?? null });
}

export async function listCalendars(account) {
  const items = [];
  let pageToken;
  do {
    const res = await api(account, 'GET', '/calendar/v3/users/me/calendarList', { query: { pageToken } });
    items.push(...(res.items || []));
    pageToken = res.nextPageToken;
  } while (pageToken);
  return items.map((c) => ({
    id: c.id,
    name: c.summaryOverride || c.summary || c.id,
    color: c.backgroundColor || '#4f8cff',
    writable: c.accessRole === 'owner' || c.accessRole === 'writer',
    primary: !!c.primary,
  }));
}

export async function listEvents(account, calendarId, timeMin, timeMax) {
  const items = [];
  let pageToken;
  do {
    const res = await api(account, 'GET', `/calendar/v3/calendars/${enc(calendarId)}/events`, {
      query: {
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 2500,
        pageToken,
      },
    });
    items.push(...(res.items || []));
    pageToken = res.nextPageToken;
  } while (pageToken);
  return items;
}

export const getEvent = (account, cal, id) =>
  api(account, 'GET', `/calendar/v3/calendars/${enc(cal)}/events/${enc(id)}`);
export const createEvent = (account, cal, body) =>
  api(account, 'POST', `/calendar/v3/calendars/${enc(cal)}/events`, { body });
export const patchEvent = (account, cal, id, body) =>
  api(account, 'PATCH', `/calendar/v3/calendars/${enc(cal)}/events/${enc(id)}`, { body });
export const deleteEvent = (account, cal, id) =>
  api(account, 'DELETE', `/calendar/v3/calendars/${enc(cal)}/events/${enc(id)}`);
export const moveEvent = (account, cal, id, destination) =>
  api(account, 'POST', `/calendar/v3/calendars/${enc(cal)}/events/${enc(id)}/move`, { query: { destination } });

/** "2026-11-10" -> Date local à meia-noite. */
export function parseDateOnly(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
