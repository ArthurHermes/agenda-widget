// Janela de configurações: edita um rascunho com prévia ao vivo no widget.
import { loadConfig, saveConfig, PALETTE, DEFAULTS } from './lib/config.js';
import { listCalendars } from './lib/google.js';

const { invoke } = window.__TAURI__.core;
const { emit, listen } = window.__TAURI__.event;
const { openUrl } = window.__TAURI__.opener;
const { getCurrentWindow } = window.__TAURI__.window;

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const clone = (v) => JSON.parse(JSON.stringify(v));

let original;
let draft;
let saved = false;

const PRESETS = {
  dark: { bg: '#10131b', opacity: 0.88, text: '#eef1f6', muted: '#9aa3b2', accent: '#4f8cff', border: true, radius: 14 },
  glass: { bg: '#0b0e14', opacity: 0.45, text: '#ffffff', muted: '#c9d1dc', accent: '#7cb3ff', border: true, radius: 18 },
  light: { bg: '#f6f7fb', opacity: 0.94, text: '#1d2230', muted: '#5f6b7c', accent: '#2563eb', border: true, radius: 14 },
  contrast: { bg: '#000000', opacity: 1, text: '#ffffff', muted: '#e0e0e0', accent: '#ffd400', border: true, radius: 6 },
  minimal: { bg: '#000000', opacity: 0, text: '#ffffff', muted: '#d0d6e0', accent: '#ffffff', border: false, radius: 0, show_footer: false, show_buttons: 'hover' },
};

// ---------- Utilidades de caminho ("appearance.bg") ----------

const getPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);
function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((o, k) => (o[k] ??= {}), obj)[last] = value;
}

function readInput(input) {
  if (input.type === 'checkbox') return input.checked;
  if (input.type === 'number' || input.type === 'range') return Number(input.value);
  return input.value;
}

function writeInput(input, value) {
  if (input.type === 'checkbox') input.checked = !!value;
  else input.value = value ?? '';
}

function fillBound() {
  for (const input of $$('[data-key]')) writeInput(input, getPath(draft, input.dataset.key));
  updateRangeLabels();
}

function updateRangeLabels() {
  for (const el of $$('[data-val]')) {
    const v = getPath(draft, el.dataset.val);
    el.textContent = el.dataset.val.endsWith('opacity') ? `${Math.round(v * 100)}%` : v;
  }
}

// ---------- Prévia ----------

let previewQueued = false;
function preview() {
  if (previewQueued) return;
  previewQueued = true;
  setTimeout(() => {
    previewQueued = false;
    emit('config-preview', draft);
  }, 30);
}

function applyWindow(cfg) {
  return invoke('apply_window_options', { layer: cfg.appearance.layer, locked: cfg.appearance.locked });
}

function changed(key) {
  updateRangeLabels();
  preview();
  if (key === 'appearance.layer' || key === 'appearance.locked') applyWindow(draft);
}

// ---------- Contas Google ----------

function status(el, text, kind = '') {
  el.textContent = text;
  el.className = `status ${kind}`;
}

function renderAccounts() {
  const root = $('#accounts');
  root.replaceChildren();
  if (!draft.accounts.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'Nenhuma conta conectada.';
    root.append(p);
    return;
  }
  for (const acc of draft.accounts) {
    const card = document.createElement('div');
    card.className = 'card';

    const head = document.createElement('div');
    head.className = 'account-head';
    const name = document.createElement('b');
    name.textContent = acc.email;
    const reload = document.createElement('button');
    reload.textContent = '⟳ Recarregar agendas';
    const remove = document.createElement('button');
    remove.className = 'danger';
    remove.textContent = 'Desconectar';
    head.append(name, reload, remove);

    const st = document.createElement('div');
    st.className = 'status';

    reload.addEventListener('click', async () => {
      status(st, 'Carregando agendas…');
      try {
        await refreshCalendars(acc);
        renderAccounts();
        preview();
      } catch (e) {
        status(st, String(e), 'err');
      }
    });
    remove.addEventListener('click', async () => {
      if (!confirm(`Desconectar ${acc.email}? O acesso será revogado.`)) return;
      try {
        await invoke('google_logout', { account: acc.id });
      } catch (e) {
        console.warn(e);
      }
      draft.accounts = draft.accounts.filter((a) => a.id !== acc.id);
      await persist();
      renderAccounts();
    });

    card.append(head);
    for (const cal of acc.calendars) {
      const row = document.createElement('label');
      row.className = 'cal';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = cal.enabled;
      cb.addEventListener('change', () => { cal.enabled = cb.checked; preview(); });
      const color = document.createElement('input');
      color.type = 'color';
      color.value = cal.color;
      color.addEventListener('input', () => { cal.color = color.value; preview(); });
      const n = document.createElement('span');
      n.className = 'name';
      n.textContent = cal.name;
      row.append(cb, color, n);
      if (cal.primary) row.append(tag('principal'));
      if (!cal.writable) row.append(tag('somente leitura'));
      card.append(row);
    }
    card.append(st);
    root.append(card);
  }
}

function tag(text) {
  const t = document.createElement('span');
  t.className = 'tag';
  t.textContent = text;
  return t;
}

async function refreshCalendars(acc) {
  const fresh = await listCalendars(acc.id);
  const old = new Map(acc.calendars.map((c) => [c.id, c]));
  acc.calendars = fresh
    .sort((a, b) => (b.primary - a.primary) || a.name.localeCompare(b.name))
    .map((c) => {
      const prev = old.get(c.id);
      return { ...c, enabled: prev ? prev.enabled : c.primary, color: prev ? prev.color : c.color };
    });
}

/** Grava o rascunho inteiro (contas precisam persistir junto com o token). */
async function persist() {
  await saveConfig(draft);
  original = clone(draft);
}

async function connect() {
  const st = $('#connect-status');
  if (!draft.google.client_id.trim() || !draft.google.client_secret.trim()) {
    status(st, 'Preencha o Client ID e o Client Secret primeiro.', 'err');
    return;
  }
  const btn = $('#btn-connect');
  btn.disabled = true;
  status(st, 'Termine o login na janela do navegador que abriu…');
  try {
    await persist(); // o Rust lê as credenciais do arquivo
    const acc = await invoke('google_login');
    let existing = draft.accounts.find((a) => a.id === acc.id);
    if (!existing) {
      existing = { ...acc, calendars: [] };
      draft.accounts.push(existing);
    }
    status(st, 'Conectado! Carregando agendas…');
    await refreshCalendars(existing);
    await persist();
    renderAccounts();
    status(st, `${acc.email} conectada.`, 'ok');
  } catch (e) {
    status(st, String(e), 'err');
  } finally {
    btn.disabled = false;
  }
}

// ---------- iCal ----------

function renderIcals() {
  const root = $('#icals');
  root.replaceChildren();
  draft.icals.forEach((ical, i) => {
    const row = document.createElement('div');
    row.className = 'ical';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = ical.enabled !== false;
    cb.title = 'Mostrar';
    cb.addEventListener('change', () => { ical.enabled = cb.checked; });
    const color = document.createElement('input');
    color.type = 'color';
    color.value = ical.color || PALETTE[i % PALETTE.length];
    color.addEventListener('input', () => { ical.color = color.value; });
    const name = document.createElement('input');
    name.placeholder = 'Nome';
    name.value = ical.name || '';
    name.addEventListener('input', () => { ical.name = name.value; });
    const del = document.createElement('button');
    del.className = 'icon danger';
    del.textContent = '✕';
    del.title = 'Remover';
    del.addEventListener('click', () => { draft.icals.splice(i, 1); renderIcals(); });
    const url = document.createElement('input');
    url.className = 'url';
    url.placeholder = 'https://calendar.google.com/calendar/ical/…/basic.ics';
    url.value = ical.url || '';
    url.spellcheck = false;
    url.addEventListener('input', () => { ical.url = url.value.trim(); });
    row.append(cb, color, name, del, url);
    root.append(row);
  });
}

// ---------- Posição ----------

function fillGeometry(g) {
  if (document.activeElement?.id?.startsWith('geo-')) return;
  $('#geo-x').value = g.x;
  $('#geo-y').value = g.y;
  $('#geo-w').value = g.width;
  $('#geo-h').value = g.height;
}

function applyGeometry() {
  invoke('set_widget_geometry', {
    x: Number($('#geo-x').value),
    y: Number($('#geo-y').value),
    width: Number($('#geo-w').value),
    height: Number($('#geo-h').value),
  });
}

// ---------- Início ----------

async function init() {
  original = await loadConfig();
  draft = clone(original);
  fillBound();
  renderAccounts();
  renderIcals();
  fillGeometry(await invoke('get_widget_geometry'));

  // Abas
  for (const b of $$('nav button')) {
    b.addEventListener('click', () => {
      $$('nav button').forEach((x) => x.classList.toggle('active', x === b));
      $$('section').forEach((s) => (s.hidden = s.id !== `tab-${b.dataset.tab}`));
    });
  }

  // Campos ligados à config
  for (const input of $$('[data-key]')) {
    input.addEventListener(input.type === 'checkbox' || input.tagName === 'SELECT' ? 'change' : 'input', () => {
      setPath(draft, input.dataset.key, readInput(input));
      changed(input.dataset.key);
    });
  }

  for (const b of $$('[data-preset]')) {
    b.addEventListener('click', () => {
      Object.assign(draft.appearance, { ...DEFAULTS.appearance, layer: draft.appearance.layer, locked: draft.appearance.locked, font: draft.appearance.font, font_size: draft.appearance.font_size, layout: draft.appearance.layout }, PRESETS[b.dataset.preset]);
      fillBound();
      preview();
    });
  }

  for (const a of $$('[data-href]')) a.addEventListener('click', () => openUrl(a.dataset.href));

  $('#btn-connect').addEventListener('click', connect);
  $('#btn-add-ical').addEventListener('click', () => {
    draft.icals.push({ name: '', url: '', color: PALETTE[draft.icals.length % PALETTE.length], enabled: true });
    renderIcals();
  });

  // Posição
  for (const id of ['geo-x', 'geo-y', 'geo-w', 'geo-h']) $(`#${id}`).addEventListener('change', applyGeometry);
  for (const b of $$('[data-corner]')) b.addEventListener('click', () => invoke('move_widget_to', { corner: b.dataset.corner }));
  for (const b of $$('[data-size]')) {
    b.addEventListener('click', () => {
      const [w, h] = b.dataset.size.split('x').map(Number);
      $('#geo-w').value = w;
      $('#geo-h').value = h;
      applyGeometry();
    });
  }
  await listen('widget-geometry', (e) => fillGeometry(e.payload));
  // "Atravessar cliques" alternado pela bandeja enquanto esta janela está aberta.
  await listen('config-changed', (e) => {
    const v = e.payload?.appearance?.click_through;
    if (typeof v === 'boolean' && v !== draft.appearance.click_through) {
      draft.appearance.click_through = v;
      original.appearance.click_through = v;
      fillBound();
    }
  });

  // Salvar / cancelar
  const win = getCurrentWindow();
  $('#btn-save').addEventListener('click', async () => {
    try {
      draft.icals = draft.icals.filter((c) => c.url);
      await saveConfig(draft);
      saved = true;
      await win.close();
    } catch (e) {
      $('#save-status').textContent = `Erro ao salvar: ${e}`;
    }
  });
  $('#btn-cancel').addEventListener('click', () => win.close());

  // Fechou sem salvar: desfaz a prévia no widget.
  await win.onCloseRequested(async () => {
    if (saved) return;
    await emit('config-preview', original);
    await applyWindow(original);
  });
}

init();
