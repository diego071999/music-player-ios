// Persistencia: estado en localStorage (copia en IndexedDB) y metadatos/carátulas en IndexedDB.
const KEY = 'music-player-ios:state';
const DB = 'music-player-ios';
let dbPromise;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('meta');
      request.result.createObjectStore('state');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

async function run(store, mode, action) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const request = action(tx.objectStore(store));
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

const quiet = (promise) => promise.catch(() => undefined);

export function saveState(config) {
  try { localStorage.setItem(KEY, JSON.stringify(config)); } catch { /* modo privado o sin espacio */ }
  quiet(run('state', 'readwrite', (s) => s.put(config, 'current')));
}

export async function loadState() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* se intenta con IndexedDB */ }
  return (await quiet(run('state', 'readonly', (s) => s.get('current')))) ?? null;
}

export const saveMeta = (id, meta) => quiet(run('meta', 'readwrite', (s) => s.put(meta, id)));
export const loadMeta = (id) => quiet(run('meta', 'readonly', (s) => s.get(id)));
export const deleteMeta = (id) => quiet(run('meta', 'readwrite', (s) => s.delete(id)));

export async function clearAll() {
  try { localStorage.removeItem(KEY); } catch { /* nada que borrar */ }
  await quiet(run('meta', 'readwrite', (s) => s.clear()));
  await quiet(run('state', 'readwrite', (s) => s.clear()));
}

export function requestPersistence() {
  navigator.storage?.persist?.().catch(() => {});
}
