// Biblioteca y archivo playlist-config.json (lógica pura).
export const CONFIG_APP = 'music-player-ios';
export const CONFIG_VERSION = 1;

export const DEFAULT_SETTINGS = Object.freeze({
  repeat: 'off',
  shuffle: false,
  scope: 'all',
  volume: 1,
  visualizer: 'auto', // auto | background | live
  lockButtons: 'tracks', // tracks | seek
  seekStep: 10, // salto en la pantalla bloqueada cuando lockButtons = seek
});

const normalizeName = (name) => String(name).normalize('NFC').trim().toLowerCase();

/** Identificador estable entre sesiones: nombre del archivo + tamaño. */
export function trackId(name, size) {
  return `${normalizeName(name)}::${Number(size) || 0}`;
}

export function titleFromName(name) {
  return String(name)
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/_/g, ' ')
    .replace(/^\s*\d{1,3}\s*[-.)]\s+/, '')
    .trim() || String(name);
}

const text = (v, max = 500) => (typeof v === 'string' ? v.slice(0, max) : '');
const positive = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);

export function cleanTrack(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = text(raw.name);
  if (!name) return null;
  const size = positive(raw.size);
  return {
    id: trackId(name, size),
    name,
    size,
    title: text(raw.title) || titleFromName(name),
    artist: text(raw.artist),
    album: text(raw.album),
    duration: positive(raw.duration),
    favorite: raw.favorite === true,
  };
}

export function cleanSettings(raw = {}) {
  const d = DEFAULT_SETTINGS;
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    repeat: oneOf(s.repeat, ['off', 'all', 'one'], d.repeat),
    shuffle: s.shuffle === true,
    scope: oneOf(s.scope, ['all', 'fav'], d.scope),
    volume: Number.isFinite(s.volume) ? Math.min(1, Math.max(0, s.volume)) : d.volume,
    visualizer: oneOf(s.visualizer, ['auto', 'background', 'live'], d.visualizer),
    lockButtons: oneOf(s.lockButtons, ['tracks', 'seek'], d.lockButtons),
    seekStep: oneOf(s.seekStep, [10, 15], d.seekStep),
  };
}

export function buildConfig({ tracks, settings, last }, now = new Date()) {
  return {
    app: CONFIG_APP,
    version: CONFIG_VERSION,
    exportedAt: now.toISOString(),
    settings: cleanSettings(settings),
    last: last?.id ? { id: last.id, position: positive(last.position) } : null,
    tracks: tracks.map(({ name, size, title, artist, album, duration, favorite }) => ({
      name, size, title, artist, album, duration, favorite: !!favorite,
    })),
  };
}

/** Valida y sanea un JSON importado. Lanza Error con un mensaje para el usuario. */
export function parseConfig(source) {
  let data;
  try {
    data = typeof source === 'string' ? JSON.parse(source.replace(/^﻿/, '')) : source;
  } catch {
    throw new Error('El archivo no es un JSON válido.');
  }
  if (!data || data.app !== CONFIG_APP || !Array.isArray(data.tracks)) {
    throw new Error('No es un playlist-config.json de esta aplicación.');
  }
  if (data.version > CONFIG_VERSION) {
    throw new Error('La configuración es de una versión más nueva de la aplicación.');
  }
  const seen = new Set();
  const tracks = [];
  for (const raw of data.tracks) {
    const t = cleanTrack(raw);
    if (t && !seen.has(t.id)) {
      seen.add(t.id);
      tracks.push(t);
    }
  }
  const last = data.last && typeof data.last.id === 'string'
    ? { id: data.last.id, position: positive(data.last.position) }
    : null;
  return { tracks, settings: cleanSettings(data.settings), last };
}

/**
 * Busca una pista por identificador; si el tamaño cambió (p. ej. se editaron
 * etiquetas) acepta el nombre solo cuando no es ambiguo y `canClaim` lo permite.
 */
export function findMatch(tracks, name, size, canClaim = () => true) {
  const id = trackId(name, size);
  const exact = tracks.find((t) => t.id === id);
  if (exact) return exact;
  const key = normalizeName(name);
  const same = tracks.filter((t) => normalizeName(t.name) === key && canClaim(t));
  return same.length === 1 ? same[0] : null;
}

/**
 * Aplica una configuración importada: su orden y favoritas mandan; las canciones
 * actuales que no figuren en ella se conservan al final.
 */
export function applyConfig(currentTracks, config, isLoaded = () => false) {
  const remaining = [...currentTracks];
  const idMap = new Map(); // id anterior -> id definitivo
  const tracks = config.tracks.map((wanted) => {
    const match = findMatch(remaining, wanted.name, wanted.size);
    if (!match) return { ...wanted };
    remaining.splice(remaining.indexOf(match), 1);
    if (!isLoaded(match.id)) return { ...wanted };
    // El audio cargado manda en identidad; la configuración, en favoritos y orden.
    idMap.set(match.id, match.id);
    idMap.set(wanted.id, match.id);
    return {
      ...wanted,
      id: match.id,
      name: match.name,
      size: match.size,
      duration: match.duration || wanted.duration,
    };
  });
  const last = config.last
    ? { ...config.last, id: idMap.get(config.last.id) ?? config.last.id }
    : null;
  return { tracks: [...tracks, ...remaining], settings: config.settings, last };
}

export function move(list, from, to) {
  const copy = [...list];
  if (from < 0 || from >= copy.length) return copy;
  const target = Math.min(copy.length - 1, Math.max(0, to));
  const [item] = copy.splice(from, 1);
  copy.splice(target, 0, item);
  return copy;
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}
