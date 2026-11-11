// Lê um arquivo .ics e devolve as ocorrências dentro de [rangeStart, rangeEnd),
// expandindo eventos recorrentes (RRULE/EXDATE) e aplicando exceções (RECURRENCE-ID).
import ICAL from './vendor/ical.js';
import { findMeetingUrl } from './lib/meeting.js';

const MAX_ITERATIONS = 20000;

function isCancelled(component) {
  return (component.getFirstPropertyValue('status') || '').toUpperCase() === 'CANCELLED';
}

function overlaps(start, end, rangeStart, rangeEnd) {
  return start < rangeEnd && (end > rangeStart || start >= rangeStart);
}

function toOccurrence(event, startTime, endTime, component, meta) {
  const start = startTime.toJSDate();
  let end = endTime ? endTime.toJSDate() : start;
  const allDay = startTime.isDate;
  if (allDay && end <= start) end = new Date(start.getTime() + 86400000);
  const location = component.getFirstPropertyValue('location') || '';
  return {
    uid: event.uid,
    title: component.getFirstPropertyValue('summary') || '(sem título)',
    location,
    meetingUrl: findMeetingUrl({
      url: component.getFirstPropertyValue('url') || '',
      location,
      description: component.getFirstPropertyValue('description') || '',
    }),
    start,
    end,
    allDay,
    calendar: meta.name,
    color: meta.color,
  };
}

export function parseCalendar(text, rangeStart, rangeEnd, meta = {}) {
  const root = new ICAL.Component(ICAL.parse(text));

  // Fusos horários declarados no próprio arquivo (o Google inclui os VTIMEZONE).
  for (const tz of root.getAllSubcomponents('vtimezone')) {
    try {
      ICAL.TimezoneService.register(tz);
    } catch {
      /* fuso inválido: o horário cai como "local" */
    }
  }

  const masters = new Map();
  const exceptions = [];
  for (const vevent of root.getAllSubcomponents('vevent')) {
    if (vevent.hasProperty('recurrence-id')) exceptions.push(vevent);
    else masters.set(vevent.getFirstPropertyValue('uid'), new ICAL.Event(vevent));
  }

  const out = [];
  const orphanExceptions = [];
  for (const ex of exceptions) {
    const master = masters.get(ex.getFirstPropertyValue('uid'));
    if (master && master.isRecurring()) master.relateException(ex);
    else orphanExceptions.push(new ICAL.Event(ex));
  }

  for (const event of [...masters.values(), ...orphanExceptions]) {
    if (!event.startDate) continue;

    if (!event.isRecurring()) {
      if (isCancelled(event.component)) continue;
      const occ = toOccurrence(event, event.startDate, event.endDate, event.component, meta);
      if (overlaps(occ.start, occ.end, rangeStart, rangeEnd)) out.push(occ);
      continue;
    }

    const it = event.iterator();
    let next;
    let n = 0;
    while ((next = it.next()) && n++ < MAX_ITERATIONS) {
      const details = event.getOccurrenceDetails(next);
      const start = details.startDate.toJSDate();
      if (start >= rangeEnd) break;
      const component = details.item.component;
      if (isCancelled(component)) continue;
      const occ = toOccurrence(event, details.startDate, details.endDate, component, meta);
      if (overlaps(occ.start, occ.end, rangeStart, rangeEnd)) out.push(occ);
    }
  }

  return out;
}
