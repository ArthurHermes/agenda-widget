// Widget principal.
import { loadConfig, normalize, writableCalendars, PALETTE } from './lib/config.js';
import { fetchAll } from './lib/sources.js';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { openUrl } = window.__TAURI__.opener;
const appWindow = window.__TAURI__.window.getCurrentWindow();

const DAY = 86400000;
const $ = (sel) => document.querySelector(sel);
const fmtTime = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const fmtWeekday = new Intl.DateTimeFormat('pt-BR', { weekday: 'long' });
const fmtDate = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long' });
const fmtDayLabel = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: 'numeric', month: 'short' });

let config = null;
let events = [];
let errors = [];
let lastUpdated = null;
let refreshTimer = null;
let loading = false;
let pending = false;

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const hasSources = () => config.accounts.some((a) => a.calendars.some((c) => c.enabled)) || config.icals.some((c) => c.enabled !== false && c.url);
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// ---------- Aparência ----------

function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/./g, '$&$&') : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function applyAppearance(a) {
  const root = document.documentElement.style;
  root.setProperty('--bg', hexToRgba(a.bg, a.opacity));
  root.setProperty('--text', a.text);
  root.setProperty('--muted', a.muted);
  root.setProperty('--accent', a.accent);
  root.setProperty('--font', a.font);
  root.setProperty('--fs', `${a.font_size}px`);
  root.setProperty('--radius', `${a.radius}px`);
  root.setProperty('--border', a.border ? '1px solid rgba(255, 255, 255, 0.08)' : '0');

  const b = document.body.classList;
  b.toggle('compact', a.layout === 'compact');
  b.toggle('no-header', !a.show_header);
  b.toggle('no-footer', !a.show_footer);
  b.toggle('locked', a.locked);
  b.toggle('no-writable', writableCalendars(config).length === 0);
  for (const m of ['hover', 'always', 'never']) b.toggle(`buttons-${m}`, a.show_buttons === m);

  root.setProperty('--ghost', a.fade_opacity);
  b.toggle('click-through', a.click_through);
  b.toggle('fade-on-hover', a.fade_on_hover);
  invoke('apply_interaction', { clickThrough: !!a.click_through, locked: !!a.locked });
}

// ---------- Mover e redimensionar (só destravado) ----------

function setupDragAndResize() {
  const list = $('#list');
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || config?.appearance.locked) return;
    // Botões, eventos e a alça têm comportamento próprio.
    if (e.target.closest('button, input, a, .event, #grip')) return;
    // Clique na barra de rolagem da lista: deixa rolar.
    if (e.target === list && e.offsetX >= list.clientWidth) return;
    e.preventDefault();
    appWindow.startDragging();
  });
  $('#grip').addEventListener('mousedown', (e) => {
    if (e.button !== 0 || config?.appearance.locked) return;
    e.preventDefault();
    appWindow.startResizeDragging('SouthEast');
  });
}

// ---------- Dados ----------

async function refresh() {
  if (!config) return;
  if (loading) { pending = true; return; }
  if (!hasSources()) { events = []; errors = []; render(); return; }

  loading = true;
  $('#btn-refresh').classList.add('spinning');
  renderStatus();

  const rangeStart = startOfDay(new Date());
  const rangeEnd = new Date(rangeStart.getTime() + config.days_ahead * DAY);
  try {
    const res = await fetchAll(config, rangeStart, rangeEnd);
    errors = res.errors;
    // Se tudo falhou (ex.: sem internet), mantém o que já estava na tela.
    if (res.errors.length < res.total) {
      events = res.events;
      lastUpdated = new Date();
    }
  } catch (e) {
    errors = [String(e)];
  }

  loading = false;
  $('#btn-refresh').classList.remove('spinning');
  render();
  if (pending) { pending = false; refresh(); }
}

function scheduleRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(refresh, Math.max(1, config.refresh_minutes) * 60000);
}

// ---------- Janelas ----------

function openSettings() {
  invoke('open_window', { label: 'settings', url: 'settings.html', title: 'Agenda Widget: configurações', width: 640, height: 720 });
}

function openEditor(params) {
  const qs = new URLSearchParams(params).toString();
  invoke('open_window', { label: `editor-${Date.now()}`, url: `event.html?${qs}`, title: 'Evento', width: 480, height: 640 });
}

function onEventClick(ev, day) {
  if (ev.source === 'google' && ev.editable) {
    openEditor({ account: ev.account, cal: ev.calendarId, id: ev.eventId });
  } else if (ev.htmlLink) {
    openUrl(ev.htmlLink);
  } else {
    const d = ev.start < day ? day : ev.start;
    openUrl(`https://calendar.google.com/calendar/r/day/${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`);
  }
}

// ---------- Tela ----------

function badgeFor(ev, now) {
  if (ev.allDay) return null;
  if (ev.start <= now && ev.end > now) return { cls: '', text: 'agora' };
  const mins = Math.round((ev.start - now) / 60000);
  if (mins > 0 && mins <= 60) return { cls: 'soon', text: `em ${mins} min` };
  return null;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function eventEl(ev, day, now) {
  const a = config.appearance;
  const row = el('div', 'event');
  if (!ev.allDay && ev.end <= now) row.classList.add('past');
  if (!ev.allDay && ev.start <= now && ev.end > now) row.classList.add('now');

  const bar = el('div', 'bar');
  bar.style.background = ev.color || PALETTE[0];

  const dayEnd = new Date(day.getTime() + DAY);
  const startsBefore = ev.start < day;
  const endsAfter = ev.end > dayEnd;
  const when = ev.allDay
    ? 'Dia todo'
    : `${startsBefore ? '…' : fmtTime.format(ev.start)} – ${endsAfter ? '…' : fmtTime.format(ev.end)}`;

  const time = el('div', 'time', ev.allDay ? 'dia' : startsBefore ? '…' : fmtTime.format(ev.start));
  const body = el('div', 'body');
  const name = el('div', 'name', ev.title);
  const badge = badgeFor(ev, now);
  if (badge) name.append(el('span', `badge ${badge.cls}`, badge.text));

  const metaParts = a.layout === 'compact' ? [] : [when];
  if (a.show_location && ev.location) metaParts.push(ev.location);
  if (a.show_calendar_name && ev.calendar) metaParts.push(ev.calendar);
  body.append(name);
  if (metaParts.length) body.append(el('div', 'meta', metaParts.join(' · ')));

  row.title = [ev.title, when, ev.location, ev.calendar].filter(Boolean).join('\n');
  row.append(bar, time, body);
  row.addEventListener('click', () => onEventClick(ev, day));
  return row;
}

function render() {
  const a = config.appearance;
  const now = new Date();
  $('#title-small').textContent = a.title || capitalize(fmtWeekday.format(now));
  $('#title-big').textContent = fmtDate.format(now);

  const list = $('#list');
  list.replaceChildren();

  if (!hasSources()) {
    const w = el('div', 'welcome');
    w.append('Nenhuma agenda conectada ainda.', document.createElement('br'), 'Conecte uma conta Google ou adicione um link iCal.');
    const b = el('button', '', 'Abrir configurações');
    b.addEventListener('click', openSettings);
    w.append(document.createElement('br'), b);
    list.append(w);
    renderStatus();
    return;
  }

  const today = startOfDay(now);
  for (let i = 0; i < config.days_ahead; i++) {
    const day = new Date(today.getTime() + i * DAY);
    const dayEnd = new Date(day.getTime() + DAY);
    let dayEvents = events
      .filter((e) => e.start < dayEnd && (e.end > day || (e.start >= day && +e.start === +e.end)))
      .sort((x, y) => (y.allDay - x.allDay) || (x.start - y.start) || x.title.localeCompare(y.title));
    if (i === 0 && !a.show_past) dayEvents = dayEvents.filter((e) => e.allDay || e.end > now);

    if (i > 0 && dayEvents.length === 0 && !a.show_empty_days) continue;

    const section = el('div', 'day');
    const head = el('div', 'day-head');
    head.append(el('h3', '', i === 0 ? 'Hoje' : i === 1 ? 'Amanhã' : fmtDayLabel.format(day).replace(/\./g, '')));
    const add = el('button', 'add', '＋');
    add.title = 'Novo evento neste dia';
    add.addEventListener('click', () => openEditor({ date: ymd(day) }));
    head.append(add);
    section.append(head);

    if (dayEvents.length === 0) section.append(el('div', 'empty', i === 0 ? 'Nada marcado hoje.' : 'Livre.'));
    for (const ev of dayEvents) section.append(eventEl(ev, day, now));
    list.append(section);
  }
  renderStatus();
}

function renderStatus() {
  const footer = $('#status');
  footer.classList.toggle('error', errors.length > 0);
  if (errors.length) footer.textContent = `Falha ao atualizar: ${errors.join(' | ')}`;
  else if (loading && !lastUpdated) footer.textContent = 'Carregando…';
  else if (lastUpdated) footer.textContent = `Atualizado às ${fmtTime.format(lastUpdated)}`;
  else footer.textContent = '';
}

// ---------- Início ----------

function useConfig(cfg) {
  config = normalize(cfg);
  applyAppearance(config.appearance);
  render();
}

async function init() {
  setupDragAndResize();
  useConfig(await loadConfig());

  $('#btn-refresh').addEventListener('click', refresh);
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-new').addEventListener('click', () => openEditor({ date: ymd(new Date()) }));
  $('#btn-open').addEventListener('click', () => openUrl('https://calendar.google.com/calendar/r'));

  // Prévia ao vivo enquanto mexe nas configurações (sem buscar eventos de novo).
  await listen('config-preview', (e) => useConfig(e.payload));
  await listen('config-changed', (e) => {
    useConfig(e.payload);
    scheduleRefresh();
    refresh();
  });
  await listen('events-changed', refresh);

  // Modo atravessar cliques: o Rust avisa se o mouse está em cima e se o Ctrl está segurado.
  await listen('pointer-state', (e) => {
    const { enabled, over, interactive } = e.payload;
    document.body.classList.toggle('ghost', enabled && over && !interactive);
    document.body.classList.toggle('ctrl-active', enabled && interactive);
  });

  // Re-desenha a cada minuto ("agora", "em 5 min") e busca de novo na virada do dia.
  let lastDay = new Date().getDate();
  setInterval(() => {
    const d = new Date().getDate();
    if (d !== lastDay) { lastDay = d; refresh(); } else render();
  }, 60000);

  if (!hasSources()) openSettings();
  scheduleRefresh();
  refresh();
}

init();
