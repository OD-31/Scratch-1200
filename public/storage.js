// Bibliothèque de samples (IndexedDB) : fichier d'origine + découpes + BPM.

const DB_NAME = 'skratch1200';
const STORE = 'samples';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const result = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
    t.onerror = () => reject(t.error);
  });
}

export const saveSample = (rec) => tx('readwrite', (s) => s.put(rec));
export const getSample = (id) => tx('readonly', (s) => s.get(id));
export const deleteSample = (id) => tx('readwrite', (s) => s.delete(id));

export async function listSamples() {
  const all = await tx('readonly', (s) => s.getAll());
  return (all || [])
    .map(({ id, name, date, srcBpm, cuts }) => ({ id, name, date, srcBpm, cuts }))
    .sort((a, b) => b.date - a.date);
}

export async function updateSample(id, patch) {
  const rec = await getSample(id);
  if (!rec) return;
  await saveSample({ ...rec, ...patch });
}

export function loadSettings() {
  try { return JSON.parse(localStorage.getItem('skratch-settings')) || {}; } catch { return {}; }
}
export function saveSettings(s) {
  try { localStorage.setItem('skratch-settings', JSON.stringify(s)); } catch { /* ignore */ }
}
