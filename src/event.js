// Editor de evento: cria, altera, move de agenda e exclui.
import { loadConfig, writableCalendars } from './lib/config.js';
import { getEvent, createEvent, patchEvent, deleteEvent, moveEvent, parseDateOnly } from './lib/google.js';

const { emit } = window.__TAURI__.event;
const { openUrl } = window.__TAURI__.opener;
const { getCurrentWindow } = window.__TAURI__.window;

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const addDays = (s, n) => { const d = parseDateOnly(s); d.setDate(d.getDate() + n); return ymd(d); };
const toDate = (date, time) => new Date(`${date}T${time || '00:00'}:00`);

let calendars = [];
let original = null; // evento carregado do Google (edição)
const win = getCurrentWindow();

function setStatus(text, kind = '') {
  $('#status').textContent = text;
  $('#status').className = `status ${kind}`;
}

function selectedCalendar() {
  return calendars[Number($('#calendar').value)];
}

function updateDot() {
  $('#cal-dot').style.background = selectedCalendar()?.color || 'transparent';
}

function fill({ title = '', location = '', description = '', allDay = false, start, end }) {
  $('#title').value = title;
  $('#location').value = location;
  $('#description').value = description;
  $('#all-day').checked = allDay;
  document.body.classList.toggle('all-day', allDay);
  $('#start-date').value = ymd(start);
  $('#start-time').value = hm(start);
  // Eventos de dia inteiro: o Google guarda o fim como "dia seguinte"; mostramos o último dia.
  $('#end-date').value = allDay ? addDays(ymd(end), -1) : ymd(end);
  $('#end-time').value = hm(end);
}

function readTimes() {
  const allDay = $('#all-day').checked;
  const sd = $('#start-date').value;
  const ed = $('#end-date').value || sd;
  if (!sd) throw new Error('Informe a data de início.');
  if (allDay) {
    if (ed < sd) throw new Error('O fim não pode ser antes do início.');
    return { allDay, start: { date: sd }, end: { date: addDays(ed, 1) } };
  }
  const st = $('#start-time').value || '09:00';
  const et = $('#end-time').value || st;
  if (toDate(ed, et) <= toDate(sd, st)) throw new Error('O fim precisa ser depois do início.');
  return {
    allDay,
    start: { dateTime: `${sd}T${st}:00`, timeZone: TZ },
    end: { dateTime: `${ed}T${et}:00`, timeZone: TZ },
  };
}

// Ao mudar o início, o fim acompanha mantendo a duração.
let lastStart = null;
function rememberStart() {
  lastStart = toDate($('#start-date').value, $('#start-time').value);
}
function shiftEnd() {
  const newStart = toDate($('#start-date').value, $('#start-time').value);
  if (!lastStart || isNaN(newStart)) return rememberStart();
  const end = toDate($('#end-date').value, $('#end-time').value);
  const moved = new Date(end.getTime() + (newStart - lastStart));
  $('#end-date').value = ymd(moved);
  $('#end-time').value = hm(moved);
  rememberStart();
}

async function save() {
  const cal = selectedCalendar();
  if (!cal) return setStatus('Nenhuma agenda com permissão de edição.', 'err');
  let times;
  try {
    times = readTimes();
  } catch (e) {
    return setStatus(e.message, 'err');
  }

  const body = {
    summary: $('#title').value.trim() || '(sem título)',
    location: $('#location').value.trim(),
    description: $('#description').value,
    start: times.start,
    end: times.end,
  };

  $('#btn-save').disabled = true;
  setStatus('Salvando…');
  try {
    if (!original) {
      await createEvent(cal.account, cal.id, body);
    } else {
      // PATCH: limpa explicitamente o formato antigo (dia inteiro <-> com horário).
      const patch = {
        ...body,
        start: times.allDay ? { date: times.start.date, dateTime: null, timeZone: null } : { ...times.start, date: null },
        end: times.allDay ? { date: times.end.date, dateTime: null, timeZone: null } : { ...times.end, date: null },
      };
      const from = { account: params.get('account'), cal: params.get('cal'), id: params.get('id') };
      if (cal.account === from.account && cal.id !== from.cal) {
        await moveEvent(from.account, from.cal, from.id, cal.id);
        await patchEvent(cal.account, cal.id, from.id, patch);
      } else if (cal.account !== from.account) {
        // Outra conta: cria lá e apaga daqui.
        await createEvent(cal.account, cal.id, body);
        await deleteEvent(from.account, from.cal, from.id);
      } else {
        await patchEvent(cal.account, cal.id, from.id, patch);
      }
    }
    await emit('events-changed');
    await win.close();
  } catch (e) {
    setStatus(String(e), 'err');
    $('#btn-save').disabled = false;
  }
}

async function remove() {
  if (!confirm('Excluir este evento?')) return;
  try {
    setStatus('Excluindo…');
    await deleteEvent(params.get('account'), params.get('cal'), params.get('id'));
    await emit('events-changed');
    await win.close();
  } catch (e) {
    setStatus(String(e), 'err');
  }
}

async function init() {
  const cfg = await loadConfig();
  calendars = writableCalendars(cfg);
  const multiAccount = new Set(calendars.map((c) => c.account)).size > 1;
  const select = $('#calendar');
  calendars.forEach((c, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = multiAccount ? `${c.name} (${c.email})` : c.name;
    select.append(opt);
  });
  const enabled = calendars.findIndex((c) => c.enabled && c.primary);
  select.value = String(enabled >= 0 ? enabled : Math.max(0, calendars.findIndex((c) => c.enabled)));
  select.addEventListener('change', updateDot);

  $('#all-day').addEventListener('change', () => document.body.classList.toggle('all-day', $('#all-day').checked));
  for (const id of ['start-date', 'start-time']) {
    $(`#${id}`).addEventListener('focus', rememberStart);
    $(`#${id}`).addEventListener('change', shiftEnd);
  }
  $('#btn-save').addEventListener('click', save);
  $('#btn-cancel').addEventListener('click', () => win.close());
  $('#btn-delete').addEventListener('click', remove);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') win.close();
    if (e.key === 'Enter' && (e.ctrlKey || e.target.id === 'title')) save();
  });

  if (!calendars.length) {
    setStatus('Conecte uma conta Google nas configurações para criar eventos.', 'err');
    $('#btn-save').disabled = true;
  }

  if (params.get('id')) {
    document.title = 'Editar evento';
    setStatus('Carregando…');
    try {
      const ev = await getEvent(params.get('account'), params.get('cal'), params.get('id'));
      original = ev;
      const allDay = !!ev.start.date;
      fill({
        title: ev.summary || '',
        location: ev.location || '',
        description: ev.description || '',
        allDay,
        start: allDay ? parseDateOnly(ev.start.date) : new Date(ev.start.dateTime),
        end: allDay ? parseDateOnly(ev.end.date) : new Date(ev.end.dateTime),
      });
      const idx = calendars.findIndex((c) => c.account === params.get('account') && c.id === params.get('cal'));
      if (idx >= 0) select.value = String(idx);
      $('#recurring-note').hidden = !ev.recurringEventId;
      $('#btn-delete').hidden = false;
      if (ev.htmlLink) {
        $('#btn-google').hidden = false;
        $('#btn-google').addEventListener('click', () => openUrl(ev.htmlLink));
      }
      setStatus('');
    } catch (e) {
      setStatus(`Não consegui carregar o evento: ${e}`, 'err');
      $('#btn-save').disabled = true;
    }
  } else {
    document.title = 'Novo evento';
    const day = params.get('date') ? parseDateOnly(params.get('date')) : new Date();
    const now = new Date();
    const start = new Date(day);
    if (ymd(day) === ymd(now)) start.setHours(now.getHours() + 1, 0, 0, 0);
    else start.setHours(9, 0, 0, 0);
    fill({ start, end: new Date(start.getTime() + 3600000) });
  }
  updateDot();
  $('#title').focus();
}

init();
