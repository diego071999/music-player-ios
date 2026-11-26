import test from 'node:test';
import assert from 'node:assert/strict';
import { step, shuffled, playableIds, nextRepeatMode } from '../js/queue.js';
import { buildConfig, parseConfig, applyConfig, cleanTrack, findMatch, move, formatTime, trackId } from '../js/library.js';
import { readTags } from '../js/metadata.js';
import { spectrum } from '../js/fft.js';

const order = ['a', 'b', 'c', 'd'];
const base = { queue: order, order, dir: 1, shuffle: false, auto: true };

test('repetición desactivada se detiene al final', () => {
  assert.equal(step({ ...base, currentId: 'd', repeat: 'off' }), null);
  assert.equal(step({ ...base, currentId: 'b', repeat: 'off' }).id, 'c');
});
test('repetir lista: desde cualquier pista llega al final y vuelve a la primera', () => {
  let id = 'c';
  const seen = [];
  for (let i = 0; i < 4; i++) { id = step({ ...base, currentId: id, repeat: 'all' }).id; seen.push(id); }
  assert.deepEqual(seen, ['d', 'a', 'b', 'c']);
});
test('repetir una: automático repite, manual avanza', () => {
  assert.equal(step({ ...base, currentId: 'b', repeat: 'one' }).id, 'b');
  assert.equal(step({ ...base, currentId: 'b', repeat: 'one', auto: false }).id, 'c');
});
test('anterior desde la primera va a la última', () => {
  assert.equal(step({ ...base, currentId: 'a', dir: -1, repeat: 'off', auto: false }).id, 'd');
});
test('pista fuera de la cola continúa según el orden', () => {
  const queue = ['a', 'd'];
  assert.equal(step({ ...base, queue, currentId: 'b', repeat: 'off' }).id, 'd');
  assert.equal(step({ ...base, queue, currentId: 'b', dir: -1, repeat: 'off' }).id, 'a');
  assert.equal(step({ ...base, queue: ['a'], currentId: 'b', repeat: 'off' }), null);
});
test('aleatorio: permutación completa y nueva vuelta sin repetir la última', () => {
  const s = shuffled(order, 'c');
  assert.equal(s[0], 'c');
  assert.deepEqual([...s].sort(), order);
  for (let i = 0; i < 50; i++) {
    const r = step({ ...base, currentId: 'd', shuffle: true, repeat: 'all' });
    assert.notEqual(r.id, 'd');
    assert.deepEqual([...r.queue].sort(), order);
  }
});
test('cola de favoritas solo con pistas cargadas; ciclo de modos', () => {
  const tracks = [{ id: 'a', favorite: true }, { id: 'b' }, { id: 'c', favorite: true }];
  assert.deepEqual(playableIds(tracks, 'fav', (id) => id !== 'c'), ['a']);
  assert.deepEqual(['off', 'all', 'one'].map(nextRepeatMode), ['all', 'one', 'off']);
});

const track = (name, size, extra = {}) => cleanTrack({ name, size, ...extra });

test('exportar e importar conserva orden, favoritas, modos y última pista', () => {
  const tracks = [track('b.mp3', 2, { favorite: true }), track('a.mp3', 1)];
  const settings = { repeat: 'all', shuffle: true, scope: 'fav' };
  const json = JSON.stringify(buildConfig({ tracks, settings, last: { id: tracks[1].id, position: 42 } }));
  const parsed = parseConfig('﻿' + json);
  const loaded = [track('a.mp3', 1), track('z.mp3', 9), track('b.mp3', 2)];
  const result = applyConfig(loaded, parsed, () => true);
  assert.deepEqual(result.tracks.map((t) => t.name), ['b.mp3', 'a.mp3', 'z.mp3']);
  assert.equal(result.tracks[0].favorite, true);
  assert.equal(result.settings.repeat, 'all');
  assert.equal(result.settings.shuffle, true);
  assert.deepEqual(result.last, { id: trackId('a.mp3', 1), position: 42 });
});
test('importar antes de cargar audios y emparejar aunque cambie el tamaño', () => {
  const config = parseConfig(buildConfig({ tracks: [track('x.mp3', 5)], settings: {}, last: null }));
  const empty = applyConfig([], config);
  assert.equal(findMatch(empty.tracks, 'X.mp3', 5).name, 'x.mp3');
  assert.equal(findMatch(empty.tracks, 'x.mp3', 8).name, 'x.mp3');
  const loaded = applyConfig([track('x.mp3', 8)], { ...config, last: { id: trackId('x.mp3', 5), position: 3 } }, () => true);
  assert.equal(loaded.tracks.length, 1);
  assert.equal(loaded.last.id, trackId('x.mp3', 8));
});
test('rechaza archivos ajenos o dañados', () => {
  assert.throws(() => parseConfig('{'), /JSON/);
  assert.throws(() => parseConfig('{"tracks":[]}'), /No es/);
  assert.throws(() => parseConfig({ app: 'music-player-ios', version: 99, tracks: [] }), /más nueva/);
  const p = parseConfig({ app: 'music-player-ios', version: 1, tracks: [null, {}, { name: 'a' }, { name: 'a' }], settings: { repeat: 'x', volume: 7 } });
  assert.equal(p.tracks.length, 1);
  assert.equal(p.settings.repeat, 'off');
  assert.equal(p.settings.volume, 1);
});
test('mover y formato de tiempo', () => {
  assert.deepEqual(move([1, 2, 3], 0, 2), [2, 3, 1]);
  assert.deepEqual(move([1, 2, 3], 2, -5), [3, 1, 2]);
  assert.equal(formatTime(65.9), '1:05');
  assert.equal(formatTime(3725), '1:02:05');
  assert.equal(formatTime(NaN), '0:00');
});
test('lee etiquetas ID3v2.3', async () => {
  const frame = (id, text) => {
    const body = Buffer.concat([Buffer.from([3]), Buffer.from(text)]);
    const head = Buffer.alloc(10); head.write(id); head.writeUInt32BE(body.length, 4);
    return Buffer.concat([head, body]);
  };
  const frames = Buffer.concat([frame('TIT2', 'Canción'), frame('TPE1', 'Artista')]);
  const head = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, frames.length]);
  const tags = await readTags(new Blob([head, frames]));
  assert.equal(tags.title, 'Canción');
  assert.equal(tags.artist, 'Artista');
});
test('la FFT localiza un tono de 1 kHz', () => {
  const rate = 22050;
  const samples = Float32Array.from({ length: 2048 }, (_, i) => Math.sin((2 * Math.PI * 1000 * i) / rate));
  const s = spectrum(samples, 0, 2048);
  const peak = s.indexOf(Math.max(...s));
  assert.ok(Math.abs((peak * rate) / 2048 - 1000) < 15);
});
