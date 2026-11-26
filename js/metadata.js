// Lector mínimo de etiquetas: ID3v2 (MP3), átomos MP4 (M4A) y FLAC.
const MAX_TAG_BYTES = 8 * 1024 * 1024;

const read = async (blob, start, length) =>
  new Uint8Array(await blob.slice(start, start + length).arrayBuffer());
const ascii = (b, start, length) => String.fromCharCode(...b.subarray(start, start + length));
const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const synchsafe = (b, o) => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];
const utf8 = (b) => new TextDecoder('utf-8').decode(b);
const picture = (bytes, mime) =>
  bytes.length ? new Blob([bytes], { type: /png/i.test(mime) ? 'image/png' : 'image/jpeg' }) : null;

function decodeText(bytes, encoding) {
  let label = ['windows-1252', 'utf-16', 'utf-16be', 'utf-8'][encoding] || 'utf-8';
  let data = bytes;
  if (encoding === 1) {
    label = data[0] === 0xfe && data[1] === 0xff ? 'utf-16be' : 'utf-16le';
    if ((data[0] === 0xff && data[1] === 0xfe) || (data[0] === 0xfe && data[1] === 0xff)) data = data.subarray(2);
  }
  return new TextDecoder(label).decode(data).split('\0')[0].trim();
}

function skipString(b, offset, wide) {
  if (wide) {
    while (offset + 1 < b.length && (b[offset] || b[offset + 1])) offset += 2;
    return offset + 2;
  }
  while (offset < b.length && b[offset]) offset++;
  return offset + 1;
}

async function parseId3(blob, head) {
  const version = head[3];
  if (version < 2 || version > 4) return {};
  const size = Math.min(synchsafe(head, 6), MAX_TAG_BYTES);
  let tag = await read(blob, 10, size);
  if (head[5] & 0x80 && version < 4) {
    // Deshacer la "unsynchronisation": FF 00 -> FF
    tag = tag.filter((v, i) => !(v === 0 && tag[i - 1] === 0xff));
  }
  const out = {};
  let o = 0;
  if (head[5] & 0x40 && version > 2) o = version === 4 ? synchsafe(tag, 0) : u32(tag, 0) + 4;
  const idLength = version === 2 ? 3 : 4;
  const headerLength = version === 2 ? 6 : 10;
  const names = { TIT2: 'title', TPE1: 'artist', TALB: 'album', TT2: 'title', TP1: 'artist', TAL: 'album' };

  while (o + headerLength <= tag.length) {
    const id = ascii(tag, o, idLength);
    if (!/^[A-Z0-9]+$/.test(id)) break;
    const length = version === 2
      ? (tag[o + 3] << 16) | (tag[o + 4] << 8) | tag[o + 5]
      : version === 4 ? synchsafe(tag, o + 4) : u32(tag, o + 4);
    if (!length || o + headerLength + length > tag.length) break;
    const body = tag.subarray(o + headerLength, o + headerLength + length);
    if (names[id]) {
      out[names[id]] = decodeText(body.subarray(1), body[0]);
    } else if ((id === 'APIC' || id === 'PIC') && !out.cover) {
      const encoding = body[0];
      let p = 1;
      let mime;
      if (id === 'PIC') {
        mime = ascii(body, 1, 3);
        p = 4;
      } else {
        const end = skipString(body, 1, false);
        mime = ascii(body, 1, end - 2);
        p = end;
      }
      p += 1; // tipo de imagen
      p = skipString(body, p, encoding === 1 || encoding === 2);
      out.cover = picture(body.slice(p), mime);
    }
    o += headerLength + length;
  }
  return out;
}

async function findAtom(blob, start, end, wanted) {
  let o = start;
  while (o + 8 <= end) {
    const h = await read(blob, o, 16);
    if (h.length < 8) return null;
    let size = u32(h, 0);
    let header = 8;
    if (size === 1 && h.length >= 16) {
      size = u32(h, 8) * 2 ** 32 + u32(h, 12);
      header = 16;
    } else if (size === 0) size = end - o;
    if (size < header) return null;
    if (ascii(h, 4, 4) === wanted) return { start: o + header, end: Math.min(o + size, end) };
    o += size;
  }
  return null;
}

async function parseMp4(blob) {
  let box = { start: 0, end: blob.size };
  for (const name of ['moov', 'udta', 'meta', 'ilst']) {
    box = await findAtom(blob, box.start, box.end, name);
    if (!box) return {};
    if (name === 'meta') box = { start: box.start + 4, end: box.end };
  }
  const data = await read(blob, box.start, Math.min(box.end - box.start, MAX_TAG_BYTES));
  const names = { '\xa9nam': 'title', '\xa9ART': 'artist', '\xa9alb': 'album', covr: 'cover' };
  const out = {};
  let o = 0;
  while (o + 24 <= data.length) {
    const size = u32(data, o);
    if (size < 8) break;
    const key = names[ascii(data, o + 4, 4)];
    if (key && ascii(data, o + 12, 4) === 'data') {
      const value = data.slice(o + 24, o + 8 + u32(data, o + 8));
      out[key] = key === 'cover'
        ? picture(value, value[0] === 0x89 ? 'png' : 'jpeg')
        : utf8(value).trim();
    }
    o += size;
  }
  return out;
}

async function parseFlac(blob) {
  const out = {};
  let o = 4;
  for (let i = 0; i < 64 && o + 4 <= blob.size; i++) {
    const h = await read(blob, o, 4);
    const type = h[0] & 0x7f;
    const length = (h[1] << 16) | (h[2] << 8) | h[3];
    if ((type === 4 || type === 6) && length <= MAX_TAG_BYTES) {
      const b = await read(blob, o + 4, length);
      const view = new DataView(b.buffer);
      if (type === 4) {
        let p = 4 + view.getUint32(0, true);
        const count = view.getUint32(p, true);
        p += 4;
        for (let n = 0; n < count && p + 4 <= b.length; n++) {
          const len = view.getUint32(p, true);
          const entry = utf8(b.subarray(p + 4, p + 4 + len));
          p += 4 + len;
          const eq = entry.indexOf('=');
          const key = { TITLE: 'title', ARTIST: 'artist', ALBUM: 'album' }[entry.slice(0, eq).toUpperCase()];
          if (key) out[key] = entry.slice(eq + 1).trim();
        }
      } else if (!out.cover) {
        const mimeLength = u32(b, 4);
        const mime = ascii(b, 8, mimeLength);
        let p = 8 + mimeLength;
        p += 4 + u32(b, p) + 16;
        out.cover = picture(b.slice(p + 4, p + 4 + u32(b, p)), mime);
      }
    }
    if (h[0] & 0x80) break;
    o += 4 + length;
  }
  return out;
}

export async function readTags(blob) {
  try {
    const head = await read(blob, 0, 12);
    if (ascii(head, 0, 3) === 'ID3') return await parseId3(blob, head);
    if (ascii(head, 4, 4) === 'ftyp') return await parseMp4(blob);
    if (ascii(head, 0, 4) === 'fLaC') return await parseFlac(blob);
  } catch {
    // Etiquetas dañadas: se usa el nombre del archivo.
  }
  return {};
}
