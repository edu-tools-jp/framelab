// db.js — IndexedDBの薄いラッパー
// projects: プロジェクト本体（メタ情報＋クリップ配列＋字幕）
// media:    動画・写真の実ファイル（Blob）。分割クリップは同じmediaを共有する

const DB_NAME = 'cutstudio';
const DB_VERSION = 1;

let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('projects')) {
          d.createObjectStore('projects', { keyPath: 'id' });
        }
        if (!d.objectStoreNames.contains('media')) {
          d.createObjectStore('media', { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx(storeName, mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    const req = fn(store);
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const idbPut = (store, value) => tx(store, 'readwrite', s => s.put(value));
export const idbGet = (store, key) => tx(store, 'readonly', s => s.get(key));
export const idbDelete = (store, key) => tx(store, 'readwrite', s => s.delete(key));
export const idbGetAll = (store) => tx(store, 'readonly', s => s.getAll());
export const idbHas = async (store, key) =>
  (await tx(store, 'readonly', s => s.getKey(key))) !== undefined;
