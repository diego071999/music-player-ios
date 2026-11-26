// Espectro en tiempo real.
//  · Modo "live": AnalyserNode de Web Audio conectado al reproductor.
//  · Modo "background": el archivo se decodifica con Web Audio (aparte) y se analiza
//    en la posición actual, sin tocar la salida de audio (no corta el segundo plano en iOS).
import { spectrum } from './fft.js';

const BARS = 48;
const FFT_SIZE = 2048;
const RATE = 22050;
const MAX_BYTES = 40 * 1024 * 1024;
const MAX_SECONDS = 15 * 60;

export class Visualizer {
  constructor(canvas, player, onStatus) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.player = player;
    this.onStatus = onStatus;
    this.levels = new Float32Array(BARS);
    this.samples = null;
    this.file = null;
    this.job = 0;
    this.frame = 0;
    this.active = false;
    document.addEventListener('visibilitychange', () => this.update());
  }

  setActive(active) { this.active = active; this.update(); }

  /** Arranca o detiene la animación y decodifica solo cuando se va a ver. */
  update() {
    const visible = this.active && !document.hidden;
    if (!visible) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
      return;
    }
    this.prepare();
    if (!this.frame) this.frame = requestAnimationFrame(() => this.draw());
  }

  async prepare() {
    const file = this.player.live ? null : this.player.file;
    if (file === this.file) return;
    this.file = file;
    this.samples = null;
    const job = ++this.job;
    this.onStatus('');
    if (!file) return;
    const duration = this.player.duration;
    if (file.size > MAX_BYTES || duration > MAX_SECONDS) {
      this.onStatus('Espectro desactivado en archivos muy largos');
      return;
    }
    try {
      const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      const context = new Offline(1, 1, RATE);
      const data = await file.arrayBuffer();
      if (job !== this.job) return;
      const buffer = await new Promise((ok, fail) => context.decodeAudioData(data, ok, fail));
      if (job !== this.job) return;
      const mono = new Float32Array(buffer.length);
      for (let c = 0; c < buffer.numberOfChannels; c++) {
        const channel = buffer.getChannelData(c);
        for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / buffer.numberOfChannels;
      }
      this.samples = { data: mono, rate: buffer.sampleRate };
    } catch {
      if (job === this.job) this.onStatus('Espectro no disponible para este formato');
    }
  }

  frequencies() {
    const { player } = this;
    if (!player.playing) return null;
    if (player.live) {
      const node = player.analyser;
      if (!node) return null;
      const bytes = new Uint8Array(node.frequencyBinCount);
      node.getByteFrequencyData(bytes);
      return { values: bytes, scale: 1 / 255, rate: player.context.sampleRate };
    }
    if (!this.samples) return null;
    const { data, rate } = this.samples;
    const offset = Math.max(0, Math.floor(player.time * rate) - FFT_SIZE / 2);
    return { values: spectrum(data, offset, FFT_SIZE), scale: 1, rate };
  }

  draw() {
    this.frame = requestAnimationFrame(() => this.draw());
    const { canvas, g } = this;
    const ratio = Math.min(3, window.devicePixelRatio || 1);
    const w = Math.round(canvas.clientWidth * ratio);
    const h = Math.round(canvas.clientHeight * ratio);
    if (!w || !h) return;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }

    const f = this.frequencies();
    g.clearRect(0, 0, w, h);
    const gradient = g.createLinearGradient(0, h, 0, 0);
    gradient.addColorStop(0, '#ff5f7e');
    gradient.addColorStop(1, '#ffc371');
    g.fillStyle = gradient;
    const slot = w / BARS;
    const width = slot * 0.62;

    for (let i = 0; i < BARS; i++) {
      let target = 0;
      if (f) {
        // Bandas logarítmicas entre 40 Hz y 10 kHz.
        const hz = (n) => 40 * (10000 / 40) ** (n / BARS);
        const binWidth = f.rate / 2 / f.values.length;
        const from = Math.min(f.values.length - 1, Math.floor(hz(i) / binWidth));
        const to = Math.min(f.values.length, Math.max(from + 1, Math.ceil(hz(i + 1) / binWidth)));
        for (let b = from; b < to; b++) target = Math.max(target, f.values[b] * f.scale);
        target **= 1.5;
      }
      const previous = this.levels[i];
      this.levels[i] = target > previous ? previous + (target - previous) * 0.6 : previous * 0.86 + target * 0.14;
      const height = Math.max(width, this.levels[i] * h);
      g.beginPath();
      if (g.roundRect) g.roundRect(i * slot + (slot - width) / 2, h - height, width, height, width / 2);
      else g.rect(i * slot + (slot - width) / 2, h - height, width, height);
      g.fill();
    }
  }
}
