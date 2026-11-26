// Lógica pura de la cola de reproducción (sin DOM, comprobable con Node).
export const REPEAT_MODES = ['off', 'all', 'one'];

export function nextRepeatMode(mode) {
  return REPEAT_MODES[(REPEAT_MODES.indexOf(mode) + 1) % REPEAT_MODES.length];
}

export function shuffled(ids, first = null, random = Math.random) {
  const rest = ids.filter((id) => id !== first);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return first !== null && ids.includes(first) ? [first, ...rest] : rest;
}

/** Pistas que pueden sonar: las cargadas, filtradas por el ámbito elegido. */
export function playableIds(tracks, scope, isLoaded) {
  return tracks
    .filter((t) => isLoaded(t.id) && (scope !== 'fav' || t.favorite))
    .map((t) => t.id);
}

/**
 * Siguiente (dir = 1) o anterior (dir = -1) pista.
 * `order` es el orden completo de la biblioteca y permite avanzar bien aunque
 * la pista actual ya no esté en la cola (p. ej. se quitó de favoritas).
 * Devuelve { id, queue } o null si la reproducción debe detenerse.
 */
export function step({ queue, order, currentId, dir, repeat, shuffle, auto = false, random = Math.random }) {
  if (auto && repeat === 'one' && currentId !== null) return { id: currentId, queue };
  if (!queue.length) return null;

  const wraps = repeat !== 'off' || !auto;
  const index = queue.indexOf(currentId);

  if (index === -1) {
    if (shuffle) return { id: queue[0], queue };
    const pos = order.indexOf(currentId);
    if (pos === -1) return { id: dir > 0 ? queue[0] : queue[queue.length - 1], queue };
    const inQueue = new Set(queue);
    for (let i = pos + dir; i >= 0 && i < order.length; i += dir) {
      if (inQueue.has(order[i])) return { id: order[i], queue };
    }
    return wraps ? { id: dir > 0 ? queue[0] : queue[queue.length - 1], queue } : null;
  }

  const target = index + dir;
  if (target >= 0 && target < queue.length) return { id: queue[target], queue };
  if (!wraps) return null;

  if (shuffle && dir > 0 && queue.length > 1) {
    // Nueva vuelta aleatoria sin repetir inmediatamente la última canción.
    const again = shuffled(queue, null, random);
    if (again[0] === currentId) again.push(again.shift());
    return { id: again[0], queue: again };
  }
  return { id: queue[(target + queue.length) % queue.length], queue };
}
