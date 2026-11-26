import { step, shuffled, playableIds, nextRepeatMode } from './queue.js';
import {
  trackId, titleFromName, cleanTrack, cleanSettings, buildConfig, parseConfig,
  applyConfig, findMatch, move, formatTime,
} from './library.js';
import { readTags } from './metadata.js';
import * as store from './storage.js';
import { Player, isIOS, bindMediaSession, showMetadata, showPlaybackState } from './player.js';
import { Visualizer } from './visualizer.js';

const $ = (id) => document.getElementById(id);
const AUDIO_FILE = /\.(mp3|m4a|m4b|aac|wav|wave|flac|aif|aiff|caf|ogg|oga|opus|mp4|webm)$/i;

const state = {
  tracks: [], // orden de la biblioteca
  settings: cleanSettings(),
  last: null, // { id, position }
  currentId: null,
  queue: [],
  view: 'all',
  query: '',
  editing: false,
};
const files = new Map(); // id -> File (solo en esta sesión)
const covers = new Map(); // id -> object URL de la carátula
const player = new Player();
const visualizer = new Visualizer($('spectrum'), player, (msg) => { $('spectrumStatus').textContent = msg; });

const byId = (id) => state.tracks.find((t) => t.id === id);
const isLoaded = (id) => files.has(id);
let ready = false;
let failures = 0;
let scrubbing = false;

/* ---------- Persistencia ---------- */
function snapshot() {
  const last = state.currentId
    ? { id: state.currentId, position: player.url ? player.time : state.last?.position || 0 }
    : state.last;
  return buildConfig({ tracks: state.tracks, settings: state.settings, last });
}
let saveTimer = 0;
function save() {
  if (!ready) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 250);
}
function saveNow() {
  if (!ready) return;
  clearTimeout(saveTimer);
  store.saveState(snapshot());
}

/* ---------- Cola ---------- */
function rebuildQueue() {
  let ids = playableIds(state.tracks, state.settings.scope, isLoaded);
  if (!state.settings.shuffle) { state.queue = ids; return; }
  const known = new Set(ids);
  const kept = state.queue.filter((id) => known.has(id));
  const had = new Set(kept);
  state.queue = [...kept, ...shuffled(ids.filter((id) => !had.has(id)))];
}
function reshuffle() {
  state.queue = [];
  const ids = playableIds(state.tracks, state.settings.scope, isLoaded);
  state.queue = state.settings.shuffle ? shuffled(ids, state.currentId) : ids;
}

/* ---------- Reproducción ---------- */
function select(id, { autoplay = true, position = 0 } = {}) {
  const track = byId(id);
  const file = files.get(id);
  if (!track || !file) return false;
  state.currentId = id;
  state.last = { id, position };
  player.load(file, position);
  if (autoplay) start();
  showMetadata(track, covers.get(id));
  renderNowPlaying();
  renderList();
  visualizer.update();
  save();
  return true;
}

function start() {
  player.play().catch((error) => {
    if (error.name === 'NotAllowedError') toast('Toca ▶︎ para iniciar la reproducción.');
  });
}

function play() {
  if (player.url) { start(); return; }
  if (!state.queue.length) {
    if (!files.size) $('audioInput').click();
    else toast('No hay canciones disponibles en esta selección.');
    return;
  }
  const preferred = state.currentId && files.has(state.currentId) ? state.currentId : state.queue[0];
  select(preferred);
}

function toggle() { player.playing ? player.pause() : play(); }

function advance(dir, auto = false) {
  const result = step({
    queue: state.queue,
    order: state.tracks.map((t) => t.id),
    currentId: state.currentId,
    dir,
    repeat: state.settings.repeat,
    shuffle: state.settings.shuffle,
    auto,
  });
  if (!result) {
    player.pause();
    player.seek(0);
    return;
  }
  state.queue = result.queue;
  if (result.id === state.currentId && player.url) {
    player.seek(0);
    start();
  } else select(result.id);
}

const next = () => advance(1);
function previous() {
  if (player.time > 3) player.seek(0);
  else advance(-1);
}

player.addEventListener('ended', () => advance(1, true));
player.addEventListener('error', () => {
  const track = byId(state.currentId);
  toast(`No se pudo reproducir “${track?.title ?? 'el archivo'}”.`);
  if (++failures <= Math.min(5, state.queue.length - 1)) advance(1);
});
player.addEventListener('play', renderTransport);
player.addEventListener('playing', () => { failures = 0; });
player.addEventListener('pause', () => { renderTransport(); saveNow(); });
player.addEventListener('seeked', () => { showPlaybackState(player); save(); });
player.addEventListener('durationchange', () => {
  const track = byId(state.currentId);
  if (track && player.duration && Math.abs(track.duration - player.duration) > 0.5) {
    track.duration = player.duration;
    renderList();
    save();
  }
  renderProgress();
  showPlaybackState(player);
  visualizer.update();
});
let lastSave = 0;
player.addEventListener('timeupdate', () => {
  renderProgress();
  if (Date.now() - lastSave > 4000) { lastSave = Date.now(); saveNow(); }
});

/* ---------- Carga de archivos ---------- */
function probeDuration(file) {
  return new Promise((resolve) => {
    const audio = new Audio();
    const url = URL.createObjectURL(file);
    const done = (value) => {
      clearTimeout(timer);
      audio.onloadedmetadata = audio.onerror = null;
      audio.removeAttribute('src');
      audio.load();
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = setTimeout(() => done(0), 4000);
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => done(Number.isFinite(audio.duration) ? audio.duration : 0);
    audio.onerror = () => done(0);
    audio.src = url;
  });
}

function setCover(id, blob) {
  if (!blob) return;
  if (covers.has(id)) URL.revokeObjectURL(covers.get(id));
  covers.set(id, URL.createObjectURL(blob));
}

async function addFiles(list) {
  const incoming = [...list].filter((f) => f.type.startsWith('audio/') || AUDIO_FILE.test(f.name));
  if (!incoming.length) { toast('No se encontraron archivos de audio.'); return; }

  const added = [];
  let matched = 0;
  for (const file of incoming) {
    let track = findMatch(state.tracks, file.name, file.size, (t) => !files.has(t.id));
    if (track) {
      const id = trackId(file.name, file.size);
      if (track.id !== id) {
        if (state.currentId === track.id) state.currentId = id;
        if (state.last?.id === track.id) state.last.id = id;
        Object.assign(track, { id, size: file.size });
      }
      if (!files.has(id)) matched++;
    } else {
      track = cleanTrack({ name: file.name, size: file.size, title: titleFromName(file.name) });
      state.tracks.push(track);
      added.push(track.id);
    }
    files.set(track.id, file);
  }
  rebuildQueue();
  restoreLast();
  renderAll();
  save();
  const parts = [];
  if (matched) parts.push(`${matched} reconocida${matched > 1 ? 's' : ''}`);
  if (added.length) parts.push(`${added.length} nueva${added.length > 1 ? 's' : ''}`);
  toast(parts.length ? `Listo: ${parts.join(' · ')}` : 'Esas canciones ya estaban cargadas.');
  store.requestPersistence();

  // Metadatos en segundo plano, una pista cada vez para no agotar memoria.
  const isNew = new Set(added);
  for (const file of incoming) {
    const track = state.tracks.find((t) => files.get(t.id) === file);
    if (!track) continue;
    const cached = await store.loadMeta(track.id);
    let meta = cached;
    if (!meta) {
      const tags = await readTags(file);
      meta = {
        title: tags.title || '', artist: tags.artist || '', album: tags.album || '',
        cover: tags.cover || null, duration: await probeDuration(file),
      };
      store.saveMeta(track.id, meta);
    }
    if (isNew.has(track.id)) {
      track.title = meta.title || track.title;
      track.artist = meta.artist || track.artist;
      track.album = meta.album || track.album;
    }
    track.duration ||= meta.duration;
    setCover(track.id, meta.cover);
    updateRow(track);
    if (track.id === state.currentId) {
      renderNowPlaying();
      showMetadata(track, covers.get(track.id));
    }
  }
  save();
}

/** Deja preparada (en pausa) la última canción escuchada en cuanto su archivo está disponible. */
function restoreLast() {
  if (player.url) return;
  const id = state.last?.id;
  if (id && files.has(id)) {
    select(id, { autoplay: false, position: state.last.position });
    if (state.settings.shuffle) reshuffle();
  }
}

/* ---------- Biblioteca ---------- */
function toggleFavorite(id) {
  const track = byId(id);
  if (!track) return;
  track.favorite = !track.favorite;
  if (state.settings.scope === 'fav') rebuildQueue();
  renderAll();
  save();
}

function reorder(from, to) {
  state.tracks = move(state.tracks, from, to);
  if (!state.settings.shuffle) rebuildQueue();
  renderList();
  save();
}

function playFrom(id, { sequence = false } = {}) {
  if (!files.has(id)) {
    toast('Vuelve a cargar este audio con el botón +.');
    return;
  }
  if (sequence) {
    state.settings.shuffle = false;
    state.settings.repeat = 'all';
  }
  state.settings.scope = state.view;
  state.currentId = id;
  reshuffle();
  select(id);
  renderModes();
}

function removeTrack(id) {
  if (state.currentId === id) {
    player.unload();
    state.currentId = null;
    state.last = null;
    showMetadata(null);
  }
  state.tracks = state.tracks.filter((t) => t.id !== id);
  files.delete(id);
  if (covers.has(id)) URL.revokeObjectURL(covers.get(id));
  covers.delete(id);
  store.deleteMeta(id);
  rebuildQueue();
  renderAll();
  save();
}

/* ---------- Configuración ---------- */
async function exportConfig() {
  const json = JSON.stringify(snapshot(), null, 2);
  const file = new File([json], 'playlist-config.json', { type: 'application/json' });
  if (isIOS && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (error) {
      if (error.name === 'AbortError') return;
    }
  }
  const link = document.createElement('a');
  link.href = URL.createObjectURL(file);
  link.download = file.name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 30000);
  toast('playlist-config.json exportado.');
}

async function importConfig(file) {
  let config;
  try {
    if (file.size > 5 * 1024 * 1024) throw new Error('El archivo es demasiado grande.');
    config = parseConfig(await file.text());
  } catch (error) {
    toast(error.message);
    return;
  }
  const result = applyConfig(state.tracks, config, isLoaded);
  state.tracks = result.tracks;
  state.settings = result.settings;
  state.view = result.settings.scope;
  player.unload();
  state.currentId = null;
  state.last = result.last;
  applySettings();
  reshuffle();
  restoreLast();
  if (!state.currentId) showMetadata(null);
  renderAll();
  save();
  const pending = state.tracks.filter((t) => !files.has(t.id)).length;
  closeSheets();
  toast(pending ? `Configuración aplicada. Faltan ${pending} audios por cargar.` : 'Configuración aplicada.');
}

function applySettings() {
  const { settings } = state;
  const live = settings.visualizer === 'live' || (settings.visualizer === 'auto' && !isIOS);
  player.setLive(live);
  player.setVolume(settings.volume);
  bindMediaSession(player, { play, next, previous }, settings);
  renderModes();
  renderVolume();
  visualizer.update();
}

/* ---------- Interfaz ---------- */
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;

function visibleTracks() {
  const q = state.query.trim().toLocaleLowerCase();
  return state.tracks.filter((t) =>
    (state.view === 'all' || t.favorite) &&
    (!q || `${t.title} ${t.artist} ${t.album} ${t.name}`.toLocaleLowerCase().includes(q)));
}

function paintCover(element, id) {
  const url = covers.get(id);
  element.style.backgroundImage = url ? `url("${url}")` : '';
  element.classList.toggle('has-image', !!url);
}

function subtitle(track) {
  if (!files.has(track.id)) return 'Pendiente de cargar';
  return track.artist || 'Artista desconocido';
}

function updateRow(track) {
  const row = $('list').querySelector(`[data-id="${CSS.escape(track.id)}"]`);
  if (!row) return;
  row.querySelector('.title').textContent = track.title;
  row.querySelector('.sub').textContent = subtitle(track);
  row.querySelector('.time').textContent = track.duration ? formatTime(track.duration) : '';
  paintCover(row.querySelector('.art'), track.id);
}

function button(action, iconName, label, extra = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `icon-btn ${extra}`;
  b.dataset.action = action;
  b.setAttribute('aria-label', label);
  b.innerHTML = icon(iconName);
  return b;
}

let dragging = false;
function renderList() {
  if (dragging) return;
  const list = $('list');
  const tracks = visibleTracks();
  const canReorder = state.editing && state.view === 'all' && !state.query;
  const rows = tracks.map((track) => {
    const li = document.createElement('li');
    li.className = 'row';
    li.dataset.id = track.id;
    li.classList.toggle('current', track.id === state.currentId);
    li.classList.toggle('missing', !files.has(track.id));
    li.innerHTML = `
      <button type="button" class="main" data-action="play">
        <span class="art">${icon('note')}<i class="bars"><b></b><b></b><b></b></i></span>
        <span class="text"><span class="title"></span><span class="sub"></span></span>
        <span class="time"></span>
      </button>`;
    if (canReorder) {
      const index = state.tracks.indexOf(track);
      const up = button('up', 'up', 'Subir');
      const down = button('down', 'down', 'Bajar');
      up.disabled = index === 0;
      down.disabled = index === state.tracks.length - 1;
      li.append(up, down, button('drag', 'grip', 'Arrastrar para reordenar', 'grip'));
    } else {
      const fav = button('fav', track.favorite ? 'heart-fill' : 'heart',
        track.favorite ? 'Quitar de favoritas' : 'Marcar como favorita', track.favorite ? 'on' : '');
      fav.setAttribute('aria-pressed', String(track.favorite));
      li.append(fav, button('menu', 'more', 'Opciones'));
    }
    return li;
  });
  list.replaceChildren(...rows);
  tracks.forEach(updateRow);

  const total = state.tracks.length;
  const loaded = state.tracks.filter((t) => files.has(t.id)).length;
  const favorites = state.tracks.filter((t) => t.favorite).length;
  $('countAll').textContent = total;
  $('countFav').textContent = favorites;
  $('summary').textContent = total ? `${loaded} de ${total} listas para sonar` : 'Tu música, solo en tu iPhone';
  $('banner').hidden = !(total && loaded < total);
  $('empty').hidden = tracks.length > 0;
  $('emptyTitle').textContent = !total ? 'Añade tu música' : state.query ? 'Sin resultados' : 'Aún no hay favoritas';
  $('emptyText').textContent = !total
    ? 'Elige canciones desde la app Archivos. Nada se sube a internet.'
    : state.query ? 'Prueba con otra búsqueda.' : 'Toca el corazón de una canción para guardarla aquí.';
  $('emptyAdd').hidden = !!total;
  $('editBtn').hidden = state.view !== 'all' || total < 2;
  $('editBtn').textContent = state.editing ? 'Listo' : 'Ordenar';
  $('playAll').disabled = !tracks.some((t) => files.has(t.id));
  for (const tab of document.querySelectorAll('[data-view]')) {
    tab.setAttribute('aria-selected', String(tab.dataset.view === state.view));
  }
}

function renderNowPlaying() {
  const track = byId(state.currentId);
  document.body.classList.toggle('has-track', !!track);
  for (const el of document.querySelectorAll('[data-now="title"]')) el.textContent = track?.title ?? 'Nada en reproducción';
  for (const el of document.querySelectorAll('[data-now="artist"]')) {
    el.textContent = track ? track.artist || 'Artista desconocido' : 'Elige una canción';
  }
  for (const el of document.querySelectorAll('[data-now="art"]')) paintCover(el, track?.id);
  const url = covers.get(track?.id);
  $('backdrop').style.backgroundImage = url ? `url("${url}")` : '';
  const fav = $('nowFav');
  fav.innerHTML = icon(track?.favorite ? 'heart-fill' : 'heart');
  fav.classList.toggle('on', !!track?.favorite);
  fav.disabled = !track;
  $('sourceLabel').textContent = state.settings.scope === 'fav' ? 'Reproduciendo Favoritas' : 'Reproduciendo Todas';
  renderProgress();
  renderTransport();
}

function renderTransport() {
  document.body.classList.toggle('playing', player.playing);
  for (const el of document.querySelectorAll('[data-action="toggle"]')) {
    el.innerHTML = icon(player.playing ? 'pause' : 'play');
    el.setAttribute('aria-label', player.playing ? 'Pausar' : 'Reproducir');
  }
  showPlaybackState(player);
}

function renderProgress() {
  const duration = player.duration || byId(state.currentId)?.duration || 0;
  const time = scrubbing ? Number($('seek').value) : player.time;
  const seek = $('seek');
  seek.max = duration || 1;
  seek.disabled = !player.url || !duration;
  if (!scrubbing) seek.value = time;
  const percent = duration ? Math.min(100, (time / duration) * 100) : 0;
  seek.style.setProperty('--fill', `${percent}%`);
  $('miniFill').style.width = `${percent}%`;
  $('elapsed').textContent = formatTime(time);
  $('remaining').textContent = `-${formatTime(Math.max(0, duration - time))}`;
  $('total').textContent = formatTime(duration);
}

function renderModes() {
  const { shuffle, repeat, visualizer: mode, lockButtons, seekStep } = state.settings;
  $('shuffleBtn').classList.toggle('on', shuffle);
  $('shuffleBtn').setAttribute('aria-pressed', String(shuffle));
  $('repeatBtn').classList.toggle('on', repeat !== 'off');
  $('repeatBtn').innerHTML = icon(repeat === 'one' ? 'repeat-one' : 'repeat');
  const label = { off: 'Repetición desactivada', all: 'Repetir toda la lista', one: 'Repetir canción actual' }[repeat];
  $('repeatBtn').setAttribute('aria-label', label);
  $('modeLabel').textContent = `${label}${shuffle ? ' · Aleatorio' : ''}`;
  $('visualizerSelect').value = mode;
  $('lockSelect').value = lockButtons;
  $('stepSelect').value = String(seekStep);
  $('stepRow').hidden = lockButtons !== 'seek';
}

function renderVolume() {
  const enabled = player.canSetVolume;
  const slider = $('volume');
  slider.value = enabled ? state.settings.volume : 1;
  slider.disabled = !enabled;
  slider.style.setProperty('--fill', `${slider.value * 100}%`);
  $('volumeNote').hidden = enabled;
}

function renderAll() {
  renderList();
  renderNowPlaying();
  renderModes();
}

let toastTimer = 0;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

/* ---------- Hojas (pantallas deslizantes) ---------- */
function openSheet(id) {
  const sheet = $(id);
  sheet.classList.add('open');
  sheet.inert = false;
  $('library').inert = true;
  $('mini').inert = true;
  if (id !== 'nowSheet') $('scrim').classList.add('show');
  if (id === 'nowSheet') visualizer.setActive(true);
}
function closeSheets() {
  for (const sheet of document.querySelectorAll('.sheet')) {
    sheet.classList.remove('open');
    sheet.inert = true;
    sheet.style.transform = '';
  }
  $('library').inert = false;
  $('mini').inert = false;
  $('scrim').classList.remove('show');
  visualizer.setActive(false);
}

let menuId = null;
function openMenu(id) {
  const track = byId(id);
  if (!track) return;
  menuId = id;
  const index = state.tracks.indexOf(track);
  $('menuTitle').textContent = track.title;
  $('menuName').textContent = track.name;
  const menu = $('menuSheet');
  menu.querySelector('[data-menu="from"]').disabled = !files.has(id);
  menu.querySelector('[data-menu="up"]').disabled = index === 0;
  menu.querySelector('[data-menu="top"]').disabled = index === 0;
  menu.querySelector('[data-menu="down"]').disabled = index === state.tracks.length - 1;
  menu.querySelector('[data-menu="bottom"]').disabled = index === state.tracks.length - 1;
  openSheet('menuSheet');
}

/* ---------- Arrastrar para reordenar ---------- */
function startDrag(event, handle) {
  const row = handle.closest('.row');
  const list = $('list');
  const scroller = $('scroller');
  const from = [...list.children].indexOf(row);
  let y = event.clientY;
  let frame = 0;
  dragging = true;
  row.classList.add('dragging');
  handle.setPointerCapture(event.pointerId);

  const place = () => {
    const others = [...list.children].filter((el) => el !== row);
    const before = others.find((el) => {
      const box = el.getBoundingClientRect();
      return y < box.top + box.height / 2;
    }) ?? null;
    // Se mueven las demás filas para no perder la captura del puntero.
    const index = before ? others.indexOf(before) : others.length;
    const current = [...list.children].indexOf(row);
    for (let i = current; i < index; i++) list.insertBefore(row.nextElementSibling, row);
    for (let i = current; i > index; i--) list.insertBefore(row.previousElementSibling, row.nextElementSibling);
  };
  const autoScroll = () => {
    const box = scroller.getBoundingClientRect();
    const edge = 70;
    const speed = y < box.top + edge ? -9 : y > box.bottom - edge ? 9 : 0;
    if (speed) { scroller.scrollTop += speed; place(); }
    frame = requestAnimationFrame(autoScroll);
  };
  const onMove = (e) => { y = e.clientY; place(); };
  const onEnd = (e) => {
    cancelAnimationFrame(frame);
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onEnd);
    handle.removeEventListener('pointercancel', onEnd);
    const to = [...list.children].indexOf(row);
    dragging = false;
    if (e.type === 'pointerup' && to !== from) reorder(from, to);
    else renderList();
  };
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onEnd);
  handle.addEventListener('pointercancel', onEnd);
  frame = requestAnimationFrame(autoScroll);
}

/* ---------- Eventos ---------- */
$('list').addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const id = target.closest('.row').dataset.id;
  const index = state.tracks.findIndex((t) => t.id === id);
  const actions = {
    play: () => !state.editing && playFrom(id),
    fav: () => toggleFavorite(id),
    menu: () => openMenu(id),
    up: () => reorder(index, index - 1),
    down: () => reorder(index, index + 1),
  };
  actions[target.dataset.action]?.();
});
$('list').addEventListener('pointerdown', (event) => {
  const handle = event.target.closest('[data-action="drag"]');
  if (handle && !dragging) { event.preventDefault(); startDrag(event, handle); }
});

for (const input of [$('addBtn'), $('emptyAdd'), $('bannerAdd')]) {
  input.addEventListener('click', () => $('audioInput').click());
}
$('audioInput').addEventListener('change', (e) => {
  const selected = [...e.target.files];
  e.target.value = '';
  if (selected.length) addFiles(selected);
});

for (const tab of document.querySelectorAll('[data-view]')) {
  tab.addEventListener('click', () => {
    state.view = tab.dataset.view;
    state.editing = false;
    renderList();
    $('scroller').scrollTop = 0;
  });
}
$('search').addEventListener('input', (e) => { state.query = e.target.value; renderList(); });
$('editBtn').addEventListener('click', () => {
  state.editing = !state.editing;
  if (state.editing) { state.query = ''; $('search').value = ''; }
  renderList();
});
$('playAll').addEventListener('click', () => {
  const ids = visibleTracks().filter((t) => files.has(t.id)).map((t) => t.id);
  if (!ids.length) return;
  playFrom(state.settings.shuffle ? ids[Math.floor(Math.random() * ids.length)] : ids[0]);
});

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target || target.closest('#list')) return;
  const { action } = target.dataset;
  if (action === 'toggle') toggle();
  else if (action === 'next') next();
  else if (action === 'previous') previous();
  else if (action === 'skip') player.skip(Number(target.dataset.seconds));
  else if (action === 'close') closeSheets();
});

$('miniOpen').addEventListener('click', () => openSheet('nowSheet'));
$('settingsBtn').addEventListener('click', () => openSheet('settingsSheet'));
$('scrim').addEventListener('click', closeSheets);
$('nowFav').addEventListener('click', () => toggleFavorite(state.currentId));
$('nowMore').addEventListener('click', () => {
  if (!state.currentId) return;
  closeSheets();
  openMenu(state.currentId);
});
$('shuffleBtn').addEventListener('click', () => {
  state.settings.shuffle = !state.settings.shuffle;
  reshuffle();
  renderModes();
  save();
});
$('repeatBtn').addEventListener('click', () => {
  state.settings.repeat = nextRepeatMode(state.settings.repeat);
  renderModes();
  toast($('repeatBtn').getAttribute('aria-label'));
  save();
});

$('seek').addEventListener('input', () => { scrubbing = true; renderProgress(); });
$('seek').addEventListener('change', () => {
  scrubbing = false;
  player.seek(Number($('seek').value));
  renderProgress();
});
for (const type of ['pointercancel', 'blur']) {
  $('seek').addEventListener(type, () => { scrubbing = false; });
}
$('volume').addEventListener('input', (e) => {
  state.settings.volume = Number(e.target.value);
  player.setVolume(state.settings.volume);
  renderVolume();
  save();
});

$('menuSheet').addEventListener('click', (event) => {
  const action = event.target.closest('[data-menu]')?.dataset.menu;
  if (!action) return;
  const id = menuId;
  const index = state.tracks.findIndex((t) => t.id === id);
  closeSheets();
  if (action === 'from') playFrom(id, { sequence: true });
  if (action === 'up') reorder(index, index - 1);
  if (action === 'down') reorder(index, index + 1);
  if (action === 'top') reorder(index, 0);
  if (action === 'bottom') reorder(index, state.tracks.length - 1);
  if (action === 'remove' && confirm('¿Quitar esta canción de la lista? El archivo original no se borra.')) removeTrack(id);
});

$('exportBtn').addEventListener('click', exportConfig);
$('importBtn').addEventListener('click', () => $('configInput').click());
$('configInput').addEventListener('change', (e) => {
  const [file] = e.target.files;
  e.target.value = '';
  if (file) importConfig(file);
});
function changeSetting(key, value) {
  const wasPlaying = player.playing;
  const wasLive = player.live;
  state.settings[key] = value;
  applySettings();
  renderNowPlaying();
  if (wasPlaying && wasLive !== player.live) start();
  save();
}
$('visualizerSelect').addEventListener('change', (e) => changeSetting('visualizer', e.target.value));
$('lockSelect').addEventListener('change', (e) => changeSetting('lockButtons', e.target.value));
$('stepSelect').addEventListener('change', (e) => changeSetting('seekStep', Number(e.target.value)));
$('resetBtn').addEventListener('click', async () => {
  if (!confirm('¿Borrar la lista, favoritas y ajustes guardados en este dispositivo?')) return;
  ready = false;
  clearTimeout(saveTimer);
  player.unload();
  await store.clearAll();
  location.reload();
});

// Deslizar hacia abajo para cerrar la pantalla de reproducción.
{
  const sheet = $('nowSheet');
  const grab = $('nowGrab');
  let startY = null;
  grab.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    startY = e.clientY;
    grab.setPointerCapture(e.pointerId);
    sheet.style.transition = 'none';
  });
  grab.addEventListener('pointermove', (e) => {
    if (startY !== null) sheet.style.transform = `translateY(${Math.max(0, e.clientY - startY)}px)`;
  });
  const end = (e) => {
    if (startY === null) return;
    const distance = e.clientY - startY;
    startY = null;
    sheet.style.transition = '';
    sheet.style.transform = '';
    if (distance > 110) closeSheets();
  };
  grab.addEventListener('pointerup', end);
  grab.addEventListener('pointercancel', end);
}

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheets(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });
window.addEventListener('pagehide', saveNow);

/* ---------- Inicio ---------- */
async function init() {
  const saved = await store.loadState();
  if (saved) {
    try {
      const config = parseConfig(saved);
      state.tracks = config.tracks;
      state.settings = config.settings;
      state.last = config.last;
      state.view = config.settings.scope;
      if (byId(config.last?.id)) state.currentId = config.last.id;
    } catch { /* estado dañado: se empieza de cero */ }
  }
  closeSheets();
  applySettings();
  renderAll();
  ready = true;
  for (const track of [...state.tracks]) {
    const meta = await store.loadMeta(track.id);
    if (meta?.cover && !covers.has(track.id)) {
      setCover(track.id, meta.cover);
      updateRow(track);
      if (track.id === state.currentId) renderNowPlaying();
    }
  }
}
init();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
