// Encontra o link de videochamada de um evento (sem depender do Tauri, para dar para testar no Node).

const MEETING_HOSTS = [
  /(^|\.)meet\.google\.com$/,
  /(^|\.)zoom\.us$/,
  /(^|\.)zoomgov\.com$/,
  /(^|\.)teams\.microsoft\.com$/,
  /(^|\.)teams\.live\.com$/,
  /(^|\.)webex\.com$/,
  /(^|\.)whereby\.com$/,
  /(^|\.)meet\.jit\.si$/,
  /(^|\.)gotomeeting\.com$/,
  /(^|\.)meet\.goto\.com$/,
  /(^|\.)chime\.aws$/,
  /(^|\.)discord\.(gg|com)$/,
  /(^|\.)skype\.com$/,
  /(^|\.)bluejeans\.com$/,
];

const URL_RE = /https?:\/\/[^\s<>"'()\[\]{}]+/gi;

function clean(url) {
  // Tira pontuação grudada no fim ("…/abc." ou "…/abc,") e entidades HTML.
  return url.replace(/&amp;/g, '&').replace(/[.,;:!?]+$/, '');
}

function isMeeting(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return MEETING_HOSTS.some((re) => re.test(host));
  } catch {
    return false;
  }
}

function urlsIn(text) {
  return (text || '').match(URL_RE)?.map(clean) || [];
}

/**
 * @param {object} p
 * @param {string} [p.hangoutLink]   Google: link do Meet
 * @param {object} [p.conferenceData] Google: dados da conferência
 * @param {string} [p.url]           iCal: propriedade URL
 * @param {string} [p.location]
 * @param {string} [p.description]
 */
export function findMeetingUrl({ hangoutLink, conferenceData, url, location, description } = {}) {
  const video = conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri;
  if (video) return video;
  if (hangoutLink) return hangoutLink;

  const candidates = [url, ...urlsIn(location), ...urlsIn(description)].filter(Boolean).map(clean);
  const meeting = candidates.find(isMeeting);
  if (meeting) return meeting;

  // Local que é só um link (ex.: sala virtual de outro serviço).
  const loc = (location || '').trim();
  if (/^https:\/\/\S+$/i.test(loc)) return clean(loc);
  return null;
}
