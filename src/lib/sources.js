// Junta os eventos de todas as fontes (contas Google + links iCal).
import { parseCalendar } from '../events.js';
import { listEvents, parseDateOnly } from './google.js';
import { findMeetingUrl } from './meeting.js';

const { invoke } = window.__TAURI__.core;

function fromGoogle(item, account, cal) {
  const allDay = !!item.start?.date;
  const start = allDay ? parseDateOnly(item.start.date) : new Date(item.start.dateTime);
  const end = allDay ? parseDateOnly(item.end.date) : new Date(item.end.dateTime);
  return {
    source: 'google',
    account: account.id,
    calendarId: cal.id,
    eventId: item.id,
    recurring: !!item.recurringEventId,
    editable: cal.writable && item.locked !== true,
    htmlLink: item.htmlLink,
    title: item.summary || '(sem título)',
    location: item.location || '',
    meetingUrl: findMeetingUrl(item),
    start,
    end,
    allDay,
    calendar: cal.name,
    color: cal.color,
  };
}

export async function fetchAll(cfg, rangeStart, rangeEnd) {
  const jobs = [];

  for (const account of cfg.accounts) {
    for (const cal of account.calendars.filter((c) => c.enabled)) {
      jobs.push({
        label: `${cal.name} (${account.email})`,
        run: async () =>
          (await listEvents(account.id, cal.id, rangeStart, rangeEnd))
            .filter((i) => i.status !== 'cancelled' && i.start)
            .map((i) => fromGoogle(i, account, cal)),
      });
    }
  }

  for (const ical of cfg.icals.filter((c) => c.enabled !== false && c.url?.trim())) {
    jobs.push({
      label: ical.name || 'iCal',
      run: async () => {
        const text = await invoke('fetch_ics', { url: ical.url });
        return parseCalendar(text, rangeStart, rangeEnd, ical).map((e) => ({ ...e, source: 'ical', editable: false }));
      },
    });
  }

  const results = await Promise.allSettled(jobs.map((j) => j.run()));
  const events = [];
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') events.push(...r.value);
    else errors.push(`${jobs[i].label}: ${r.reason}`);
  });
  return { events, errors, total: jobs.length };
}
