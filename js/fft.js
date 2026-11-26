// FFT radix-2 en el sitio, para el espectro calculado sobre audio ya decodificado.
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = (-2 * Math.PI) / size;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let start = 0; start < n; start += size) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < size / 2; k++) {
        const a = start + k;
        const b = a + size / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
      }
    }
  }
}

/** Magnitudes en escala 0..1 (equivalente a -90..-15 dB) de una ventana de muestras. */
export function spectrum(samples, offset, size) {
  const re = new Float32Array(size);
  const im = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
    re[i] = (samples[offset + i] || 0) * hann;
  }
  fft(re, im);
  const out = new Float32Array(size / 2);
  for (let i = 0; i < out.length; i++) {
    const db = 20 * Math.log10((Math.hypot(re[i], im[i]) * 4) / size + 1e-9);
    out[i] = Math.min(1, Math.max(0, (db + 90) / 75));
  }
  return out;
}
