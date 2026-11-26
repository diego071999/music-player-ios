// Motor de audio: HTML5 Audio + (opcional) grafo Web Audio + Media Session.
export const isIOS =
  /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const supportsElementVolume = (() => {
  if (isIOS) return false; // iOS ignora audio.volume
  const probe = new Audio();
  probe.volume = 0.5;
  return probe.volume === 0.5;
})();

export class Player extends EventTarget {
  constructor() {
    super();
    this.live = false;
    this.volume = 1;
    this.url = null;
    this.context = null;
    this.analyser = null;
    this.gain = null;
    this.pendingSeek = 0;
    this.createElement();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !this.audio.paused) this.resumeContext();
    });
  }

  createElement() {
    const audio = new Audio();
    audio.preload = 'auto';
    audio.setAttribute('playsinline', '');
    this.audio = audio;
    for (const type of ['play', 'playing', 'pause', 'timeupdate', 'durationchange', 'ended', 'error', 'seeked']) {
      audio.addEventListener(type, () => {
        if (audio !== this.audio || !this.url) return;
        this.dispatchEvent(new Event(type));
      });
    }
    audio.addEventListener('loadedmetadata', () => {
      if (audio !== this.audio) return;
      if (this.pendingSeek > 0 && this.pendingSeek < audio.duration - 2) audio.currentTime = this.pendingSeek;
      this.pendingSeek = 0;
    });
  }

  get canSetVolume() { return this.live || supportsElementVolume; }
  get playing() { return !this.audio.paused; }
  get time() { return this.pendingSeek || this.audio.currentTime || 0; }
  get duration() { return Number.isFinite(this.audio.duration) ? this.audio.duration : 0; }

  /** Cambiar de modo exige un elemento nuevo: un elemento conectado a Web Audio no se puede desconectar. */
  setLive(live) {
    if (live === this.live) return;
    const hadFile = this.file;
    const position = this.time;
    this.unload();
    this.context?.close().catch(() => {});
    this.context = this.analyser = this.gain = null;
    this.live = live;
    this.createElement();
    this.setVolume(this.volume);
    if (hadFile) this.load(hadFile, position);
  }

  load(file, position = 0) {
    const previous = this.url;
    this.file = file;
    this.url = URL.createObjectURL(file);
    this.pendingSeek = position;
    this.audio.src = this.url;
    this.audio.load();
    if (previous) URL.revokeObjectURL(previous);
  }

  unload() {
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = this.file = null;
    this.pendingSeek = 0;
  }

  /** Debe llamarse de forma síncrona desde un toque, 'ended' o Media Session. */
  play() {
    if (!this.url) return Promise.resolve();
    // Safari 16.4+: marca el audio como contenido principal (suena en segundo plano y en silencio).
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* no disponible */ }
    if (this.live) {
      this.connect();
      this.resumeContext();
    }
    return this.audio.play();
  }

  pause() { this.audio.pause(); }

  connect() {
    if (this.context) return;
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return;
    this.context = new Context();
    const source = this.context.createMediaElementSource(this.audio);
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.78;
    this.gain = this.context.createGain();
    source.connect(this.analyser).connect(this.gain).connect(this.context.destination);
    this.audio.volume = 1;
    this.gain.gain.value = this.volume;
  }

  resumeContext() {
    if (this.context && this.context.state !== 'running') this.context.resume().catch(() => {});
  }

  setVolume(value) {
    this.volume = Math.min(1, Math.max(0, value));
    if (this.gain) this.gain.gain.value = this.volume;
    else if (supportsElementVolume) this.audio.volume = this.volume;
  }

  seek(seconds) {
    if (!this.url) return;
    if (!this.duration) { this.pendingSeek = Math.max(0, seconds); return; }
    this.pendingSeek = 0;
    this.audio.currentTime = Math.min(this.duration, Math.max(0, seconds));
  }

  skip(delta) { this.seek(this.time + delta); }
}

/* ---------- Media Session (pantalla bloqueada / Dynamic Island) ---------- */
const session = navigator.mediaSession;

function handler(action, fn) {
  try { session.setActionHandler(action, fn); } catch { /* acción no admitida */ }
}

export function bindMediaSession(player, { next, previous, play }, { lockButtons, seekStep }) {
  if (!session) return;
  handler('play', play);
  handler('pause', () => player.pause());
  handler('stop', () => player.pause());
  handler('seekto', (e) => player.seek(e.seekTime));
  // iOS muestra saltos O cambio de pista, no ambos.
  const seek = lockButtons === 'seek';
  handler('previoustrack', seek ? null : previous);
  handler('nexttrack', seek ? null : next);
  handler('seekbackward', seek ? (e) => player.skip(-(e.seekOffset || seekStep)) : null);
  handler('seekforward', seek ? (e) => player.skip(e.seekOffset || seekStep) : null);
}

export function showMetadata(track, coverUrl) {
  if (!session || !window.MediaMetadata) return;
  if (!track) { session.metadata = null; return; }
  const fallback = new URL('icons/icon-512.png', document.baseURI).href;
  session.metadata = new MediaMetadata({
    title: track.title,
    artist: track.artist || 'Artista desconocido',
    album: track.album || '',
    artwork: [coverUrl ? { src: coverUrl, sizes: '512x512' } : { src: fallback, sizes: '512x512', type: 'image/png' }],
  });
}

export function showPlaybackState(player) {
  if (!session) return;
  session.playbackState = player.url ? (player.playing ? 'playing' : 'paused') : 'none';
  if (!session.setPositionState || !player.duration) return;
  try {
    session.setPositionState({
      duration: player.duration,
      playbackRate: player.audio.playbackRate || 1,
      position: Math.min(player.time, player.duration),
    });
  } catch { /* valores transitorios durante el cambio de pista */ }
}
