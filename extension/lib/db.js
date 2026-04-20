const DB_NAME     = 'screenfellow';
const DB_VERSION  = 3;
const STORE       = 'screenshots';
const ANNOT_STORE = 'annotations';
const THUMB_STORE = 'thumbnails';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE))       db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(ANNOT_STORE)) db.createObjectStore(ANNOT_STORE);
      if (!db.objectStoreNames.contains(THUMB_STORE)) db.createObjectStore(THUMB_STORE);
    };
    req.onsuccess  = e => resolve(e.target.result);
    req.onerror    = e => reject(e.target.error);
  });
}

// ─── Screenshots ──────────────────────────────────────────────────────────────

export async function dbSave(id, blob) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(blob, id);
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(e.target.error);
  });
}

export async function dbLoad(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = e => resolve(e.target.result ?? null);
    req.onerror   = e => reject(e.target.error);
  });
}

export async function dbDelete(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(e.target.error);
  });
}

export async function dbDeleteMany(ids) {
  if (!ids.length) return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    ids.forEach(id => store.delete(id));
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(e.target.error);
  });
}

// ─── Annotations ─────────────────────────────────────────────────────────────

export async function dbSaveAnnotations(id, data) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ANNOT_STORE, 'readwrite');
    tx.objectStore(ANNOT_STORE).put(data, id);
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(e.target.error);
  });
}

export async function dbLoadAnnotations(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(ANNOT_STORE, 'readonly');
    const req = tx.objectStore(ANNOT_STORE).get(id);
    req.onsuccess = e => resolve(e.target.result ?? null);
    req.onerror   = e => reject(e.target.error);
  });
}

export async function dbDeleteAnnotations(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ANNOT_STORE, 'readwrite');
    tx.objectStore(ANNOT_STORE).delete(id);
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(e.target.error);
  });
}

export async function dbDeleteManyAnnotations(ids) {
  if (!ids.length) return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(ANNOT_STORE, 'readwrite');
    const store = tx.objectStore(ANNOT_STORE);
    ids.forEach(id => store.delete(id));
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(e.target.error);
  });
}

// ─── Thumbnails ───────────────────────────────────────────────────────────────

export async function dbSaveThumbnail(id, dataUrl) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(THUMB_STORE, 'readwrite');
    tx.objectStore(THUMB_STORE).put(dataUrl, id);
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(e.target.error);
  });
}

export async function dbLoadThumbnail(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(THUMB_STORE, 'readonly');
    const req = tx.objectStore(THUMB_STORE).get(id);
    req.onsuccess = e => resolve(e.target.result ?? null);
    req.onerror   = e => reject(e.target.error);
  });
}

export async function dbDeleteThumbnail(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(THUMB_STORE, 'readwrite');
    tx.objectStore(THUMB_STORE).delete(id);
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(e.target.error);
  });
}

export async function dbDeleteManyThumbnails(ids) {
  if (!ids.length) return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(THUMB_STORE, 'readwrite');
    const store = tx.objectStore(THUMB_STORE);
    ids.forEach(id => store.delete(id));
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(e.target.error);
  });
}
