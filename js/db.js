// Stockage local (IndexedDB) : titres, playlists et fichiers (audio + pochettes)
const DB_NAME = 'sillon';
const DB_VERSION = 1;
let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('tracks')) db.createObjectStore('tracks', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('playlists')) db.createObjectStore('playlists', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
      if (!db.objectStoreNames.contains('covers')) db.createObjectStore('covers', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function done(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run(storeName, mode, fn) {
  const db = await open();
  const tx = db.transaction(storeName, mode);
  const finished = new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction annulée'));
  });
  const out = fn(tx.objectStore(storeName));
  const value = out instanceof IDBRequest ? await done(out) : out;
  await finished;
  return value;
}

export const db = {
  getAll: (store) => run(store, 'readonly', (s) => s.getAll()),
  get: (store, key) => run(store, 'readonly', (s) => s.get(key)),
  put: (store, value, key) => run(store, 'readwrite', (s) => (key === undefined ? s.put(value) : s.put(value, key))),
  putMany: (store, values) => run(store, 'readwrite', (s) => { values.forEach((v) => s.put(v)); }),
  delete: (store, key) => run(store, 'readwrite', (s) => s.delete(key)),
  deleteMany: (store, keys) => run(store, 'readwrite', (s) => { keys.forEach((k) => s.delete(k)); }),
  clear: (store) => run(store, 'readwrite', (s) => s.clear()),
};

export function uid(prefix = '') {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
