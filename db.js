const DATABASE_NAME = "password-anomaly-detector";
const DATABASE_VERSION = 2;
const SESSION_STORE = "sessions";
const MODEL_STORE = "models";

function requestAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
}

let databasePromise;

export function openDatabase() {
  databasePromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(SESSION_STORE)) {
        const sessions = database.createObjectStore(SESSION_STORE, { keyPath: "id" });
        sessions.createIndex("capturedAt", "capturedAt");
      }
      if (!database.objectStoreNames.contains(MODEL_STORE)) {
        database.createObjectStore(MODEL_STORE, { keyPath: "id" });
      }
    });
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
  return databasePromise;
}

async function runTransaction(storeName, mode, callback) {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, mode);
  const result = await callback(transaction.objectStore(storeName));
  await new Promise((resolve, reject) => {
    transaction.addEventListener("complete", resolve, { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error), { once: true });
  });
  return result;
}

export async function saveSession(session, maximumSessions) {
  return saveMultipleSessions([session], maximumSessions);
}

export async function saveMultipleSessions(sessionsArray, maximumSessions) {
  return runTransaction(SESSION_STORE, "readwrite", async (store) => {
    for (const session of sessionsArray) {
      await requestAsPromise(store.put(session));
    }
    const all = await requestAsPromise(store.getAll());
    const expired = all
      .sort((first, second) => first.capturedAt - second.capturedAt)
      .slice(0, Math.max(0, all.length - maximumSessions));
    await Promise.all(expired.map((record) => requestAsPromise(store.delete(record.id))));
  });
}

export async function getSessions() {
  return runTransaction(SESSION_STORE, "readonly", async (store) => {
    const sessions = await requestAsPromise(store.getAll());
    return sessions.sort((first, second) => second.capturedAt - first.capturedAt);
  });
}

export async function clearDatabase() {
  const database = await openDatabase();
  const transaction = database.transaction(SESSION_STORE, "readwrite");
  transaction.objectStore(SESSION_STORE).clear();
  await new Promise((resolve, reject) => {
    transaction.addEventListener("complete", resolve, { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error), { once: true });
  });
}

export async function saveModel(model) {
  return runTransaction(MODEL_STORE, "readwrite", async (store) => {
    await requestAsPromise(store.put({ id: "isolation_forest", ...model }));
  });
}

export async function getModel() {
  return runTransaction(MODEL_STORE, "readonly", async (store) => {
    return requestAsPromise(store.get("isolation_forest"));
  });
}
