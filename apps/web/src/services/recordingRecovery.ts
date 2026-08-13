const DATABASE_NAME = 'irving-recording-recovery';
const DATABASE_VERSION = 1;
const META_STORE = 'meta';
const CHUNK_STORE = 'chunks';

export type RecordingRecoveryMeta = {
  key: 'active';
  mimeType: string;
  transcript: string;
  startedAt: string;
};

type StoredChunk = {
  sequence: number;
  blob: Blob;
};

export type RecoveredRecording = {
  meta: RecordingRecoveryMeta;
  chunks: Blob[];
};

function openRecoveryDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(
      DATABASE_NAME,
      DATABASE_VERSION,
    );

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(META_STORE)) {
        database.createObjectStore(META_STORE, {
          keyPath: 'key',
        });
      }

      if (!database.objectStoreNames.contains(CHUNK_STORE)) {
        database.createObjectStore(CHUNK_STORE, {
          keyPath: 'sequence',
        });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        request.error ??
          new Error('Unable to open recording recovery storage.'),
      );
  });
}

function waitForTransaction(
  transaction: IDBTransaction,
): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(
        transaction.error ??
          new Error('Recording recovery storage failed.'),
      );
    transaction.onabort = () =>
      reject(
        transaction.error ??
          new Error('Recording recovery storage was interrupted.'),
      );
  });
}

export async function beginRecordingRecovery(
  mimeType: string,
  transcript: string,
): Promise<void> {
  const database = await openRecoveryDatabase();

  try {
    const transaction = database.transaction(
      [META_STORE, CHUNK_STORE],
      'readwrite',
    );

    transaction.objectStore(CHUNK_STORE).clear();
    transaction.objectStore(META_STORE).put({
      key: 'active',
      mimeType,
      transcript,
      startedAt: new Date().toISOString(),
    } satisfies RecordingRecoveryMeta);

    await waitForTransaction(transaction);
  } finally {
    database.close();
  }
}

export async function appendRecordingRecoveryChunk(
  sequence: number,
  blob: Blob,
): Promise<void> {
  const database = await openRecoveryDatabase();

  try {
    const transaction = database.transaction(
      CHUNK_STORE,
      'readwrite',
    );

    transaction.objectStore(CHUNK_STORE).put({
      sequence,
      blob,
    } satisfies StoredChunk);

    await waitForTransaction(transaction);
  } finally {
    database.close();
  }
}

export async function loadRecordingRecovery(): Promise<RecoveredRecording | null> {
  const database = await openRecoveryDatabase();

  try {
    const transaction = database.transaction(
      [META_STORE, CHUNK_STORE],
      'readonly',
    );

    const metaRequest =
      transaction.objectStore(META_STORE).get('active');

    const chunksRequest =
      transaction.objectStore(CHUNK_STORE).getAll();

    const meta = await new Promise<RecordingRecoveryMeta | undefined>(
      (resolve, reject) => {
        metaRequest.onsuccess = () =>
          resolve(
            metaRequest.result as
              | RecordingRecoveryMeta
              | undefined,
          );
        metaRequest.onerror = () =>
          reject(metaRequest.error);
      },
    );

    const chunks = await new Promise<StoredChunk[]>(
      (resolve, reject) => {
        chunksRequest.onsuccess = () =>
          resolve(chunksRequest.result as StoredChunk[]);
        chunksRequest.onerror = () =>
          reject(chunksRequest.error);
      },
    );

    await waitForTransaction(transaction);

    if (!meta || chunks.length === 0) {
      return null;
    }

    chunks.sort(
      (left, right) => left.sequence - right.sequence,
    );

    return {
      meta,
      chunks: chunks.map((chunk) => chunk.blob),
    };
  } finally {
    database.close();
  }
}

export async function clearRecordingRecovery(): Promise<void> {
  const database = await openRecoveryDatabase();

  try {
    const transaction = database.transaction(
      [META_STORE, CHUNK_STORE],
      'readwrite',
    );

    transaction.objectStore(META_STORE).clear();
    transaction.objectStore(CHUNK_STORE).clear();

    await waitForTransaction(transaction);
  } finally {
    database.close();
  }
}
