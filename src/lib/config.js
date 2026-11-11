// Configuração compartilhada entre widget, configurações e editor.
const { invoke } = window.__TAURI__.core;
const { emit } = window.__TAURI__.event;

export const PALETTE = ['#4f8cff', '#34c38f', '#f7b84b', '#f06595', '#a78bfa', '#22d3ee', '#fb923c', '#94a3b8'];

export const DEFAULTS = {
  version: 2,
  days_ahead: 7,
  refresh_minutes: 10,
  google: { client_id: '', client_secret: '' },
  // { id, email, calendars: [{ id, name, color, enabled, writable, primary }] }
  accounts: [],
  // { name, url, color, enabled }
  icals: [],
  appearance: {
    layer: 'desktop', // desktop | normal | top
    locked: false,
    click_through: false, // cliques passam para o que está atrás; Ctrl para interagir
    fade_on_hover: true, // com click_through: some quando o mouse passa por cima
    fade_opacity: 0.12,
    title: '',
    bg: '#10131b',
    opacity: 0.88,
    text: '#eef1f6',
    muted: '#9aa3b2',
    accent: '#4f8cff',
    font: '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif',
    font_size: 13.5,
    radius: 14,
    border: true,
    layout: 'list', // list | compact
    show_header: true,
    show_footer: true,
    show_location: true,
    show_calendar_name: false,
    show_past: true,
    show_empty_days: false,
    show_buttons: 'hover', // hover | always | never
    meeting_click: 'join', // join (clique abre a reunião) | edit (clique edita)
    show_join_button: true,
  },
};

const clone = (v) => JSON.parse(JSON.stringify(v));

function merge(base, extra) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return extra === undefined ? base : extra;
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    out[k] = k in base && typeof base[k] === 'object' && !Array.isArray(base[k]) && base[k] !== null ? merge(base[k], v) : v;
  }
  return out;
}

export function normalize(raw = {}) {
  const cfg = merge(clone(DEFAULTS), raw);
  // Migração da versão 0.1 (só iCal).
  if (Array.isArray(raw.calendars) && !raw.icals) {
    cfg.icals = raw.calendars.map((c) => ({ enabled: true, ...c }));
  }
  if (typeof raw.opacity === 'number' && !raw.appearance) cfg.appearance.opacity = raw.opacity;
  delete cfg.calendars;
  delete cfg.opacity;
  cfg.version = 2;
  return cfg;
}

export async function loadConfig() {
  return normalize(await invoke('get_config'));
}

export async function saveConfig(cfg) {
  await invoke('save_config', { config: cfg });
  await emit('config-changed', cfg);
}

export function writableCalendars(cfg) {
  return cfg.accounts.flatMap((a) =>
    a.calendars.filter((c) => c.writable).map((c) => ({ ...c, account: a.id, email: a.email })),
  );
}
