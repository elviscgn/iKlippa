export interface StoredMediaSource {
  sourceId: string;
  file: File;
  updatedAt: number;
}

interface MediaRecord {
  sourceId: string;
  blob: Blob;
  name: string;
  type: string;
  lastModified: number;
  updatedAt: number;
}

const DB_NAME = 'iklippa-media';
const DB_VERSION = 1;
const STORE_NAME = 'sources';

let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB is unavailable in this browser.'));
  }

  databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'sourceId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open the media cache.'));
    request.onblocked = () => reject(new Error('The media cache is blocked by another tab.'));
  }).catch((error) => {
    databasePromise = null;
    throw error;
  });

  return databasePromise;
}

async function runRequest<T>(
  mode: IDBTransactionMode,
  makeRequest: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const request = makeRequest(transaction.objectStore(STORE_NAME));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Media cache request failed.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Media cache transaction aborted.'));
  });
}

export async function persistSourceFile(sourceId: string, file: File): Promise<void> {
  const record: MediaRecord = {
    sourceId,
    blob: file,
    name: file.name,
    type: file.type,
    lastModified: file.lastModified,
    updatedAt: Date.now(),
  };
  await runRequest('readwrite', (store) => store.put(record));
}

export async function loadStoredSourceFiles(
  sourceIds?: Iterable<string>,
): Promise<StoredMediaSource[]> {
  const requested = sourceIds ? new Set(sourceIds) : null;
  const records = await runRequest<MediaRecord[]>('readonly', (store) => store.getAll());
  return records
    .filter((record) => !requested || requested.has(record.sourceId))
    .map((record) => ({
      sourceId: record.sourceId,
      file: new File([record.blob], record.name, {
        type: record.type || record.blob.type,
        lastModified: record.lastModified,
      }),
      updatedAt: record.updatedAt,
    }));
}

export async function listStoredSourceIds(): Promise<string[]> {
  return runRequest<IDBValidKey[]>('readonly', (store) => store.getAllKeys())
    .then((keys) => keys.map(String));
}

export async function hasStoredSource(sourceId: string): Promise<boolean> {
  const key = await runRequest<IDBValidKey | undefined>(
    'readonly',
    (store) => store.getKey(sourceId),
  );
  return key !== undefined;
}

export async function requestDurableStorage(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted?.()) return true;
  return navigator.storage.persist();
}

