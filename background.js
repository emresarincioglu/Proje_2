import { saveSession, getSessions, saveModel, getModel } from "./db.js";

const MAX_SESSIONS = 200;
const TRAINING_THRESHOLD = 50;
const MODEL_URL = "model/isolation_forest.json";
const MODEL_FORMAT = "isolation-forest-tree-v1";
const FEATURE_NAMES = [
  "keyHoldCount", "keyHoldMinMs", "keyHoldMaxMs", "keyHoldMedianMs", "keyHoldP90Ms",
  "keyTransitionCount", "keyTransitionMinMs", "keyTransitionMaxMs", "keyTransitionMedianMs", "keyTransitionP90Ms",
  "passwordEntryDurationMs", "backspaceCount"
];

let modelPromise;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "sessions-imported") {
    trainImportedSessions()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type !== "password-typing-summary") return;
  saveSummary(message.summary)
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function saveSummary(summary) {
  const model = await loadModel();
  const classification = classify(summary, model);
  const record = {
    ...summary,
    id: crypto.randomUUID(),
    capturedAt: Date.now(),
    anomalyScore: classification.score === null ? null : round(classification.score),
    anomalous: classification.anomalous
  };
  await saveSession(record, MAX_SESSIONS);
  if (record.anomalous) {
    chrome.notifications.create(`password-anomaly-${record.id}`, {
      type: "basic",
      iconUrl: "icon128.svg",
      title: "Password Anomaly Detector",
      message: "Son giriş davranışları eğitilmiş modelden farklı görünüyor."
    });
  }
  
  await triggerTrainingIfNeeded();
}

async function triggerTrainingIfNeeded() {
  const data = await chrome.storage.local.get("totalSessionsCollected");
  const newTotal = (data.totalSessionsCollected || 0) + 1;
  await chrome.storage.local.set({ totalSessionsCollected: newTotal });

  if (newTotal > 0 && newTotal % TRAINING_THRESHOLD === 0) {
    await trainCurrentSessions(null, newTotal);
  }
}

async function trainImportedSessions() {
  const sessions = await getSessions();
  if (sessions.length < TRAINING_THRESHOLD) return;
  await trainCurrentSessions(sessions);
}

async function trainCurrentSessions(sessions = null, totalCount = null) {
  try {
    sessions ??= await getSessions();
    if (sessions.length < 2) return;
    const response = await fetch("http://localhost:5000/train", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessions })
    });
    if (!response.ok) throw new Error("Training failed on server");
    const newModel = await response.json();
    validateModel(newModel);
    await saveModel(newModel);
    modelPromise = Promise.resolve(newModel); // Update in-memory model
    console.log(`Trained new model with ${sessions.length} sessions${totalCount === null ? "" : ` at total count ${totalCount}`}`);
  } catch (error) {
    console.error("Failed to train model:", error);
  }
}

async function loadModel() {
  if (modelPromise) return modelPromise;

  modelPromise = getModel().then((dbModel) => {
    if (dbModel) return validateModel(dbModel);
    
    return fetch(chrome.runtime.getURL(MODEL_URL))
      .then((response) => {
        if (!response.ok) return null;
        return response.json();
      })
      .then((model) => {
        if (!model) return null;
        return validateModel(model);
      })
      .catch(() => null);
  });
  return modelPromise;
}

// Check on startup if we already have enough sessions to train, and don't have a model yet.
chrome.runtime.onStartup.addListener(async () => {
  const model = await loadModel();
  if (!model) {
    const sessions = await getSessions();
    if (sessions.length >= TRAINING_THRESHOLD) {
      await chrome.storage.local.set({ totalSessionsCollected: sessions.length - 1 });
      await triggerTrainingIfNeeded();
    }
  }
});

// Also check right now in case the service worker just installed or reloaded
loadModel().then(async (model) => {
  if (!model) {
    const sessions = await getSessions();
    if (sessions.length >= TRAINING_THRESHOLD) {
      await chrome.storage.local.set({ totalSessionsCollected: sessions.length - 1 });
      await triggerTrainingIfNeeded();
    }
  }
});

function validateModel(model) {
  if (!model || model.format !== MODEL_FORMAT || model.featureSchemaVersion !== 1 || !Array.isArray(model.trees) || !model.trees.length ||
      !Number.isFinite(model.sampleSize) || model.sampleSize < 2 || !Number.isFinite(model.anomalyThreshold) ||
      !Array.isArray(model.featureNames) || model.featureNames.join("|") !== FEATURE_NAMES.join("|")) {
    throw new Error("Isolation Forest model dosyası geçersiz.");
  }
  return model;
}

function classify(session, model) {
  if (!model) return { score: null, anomalous: false };
  const vector = toFeatureVector(session);
  if (!vector) return { score: null, anomalous: false };
  const averagePath = model.trees.reduce((total, tree) => total + pathLength(tree, vector), 0) / model.trees.length;
  const score = 2 ** (-averagePath / averagePathLengthFor(model.sampleSize));
  return { score, anomalous: score >= model.anomalyThreshold };
}

function toFeatureVector(session) {
  if (!Array.isArray(session.keyHoldDurations) || !Array.isArray(session.keyTransitionDurations) ||
      !Number.isFinite(session.passwordEntryDurationMs) || !Number.isFinite(session.backspaceCount)) return null;
  const holds = timingFeatures(session.keyHoldDurations);
  const transitions = timingFeatures(session.keyTransitionDurations);
  const vector = [...holds, ...transitions, session.passwordEntryDurationMs, session.backspaceCount];
  return vector.every((value) => Number.isFinite(value) && value >= 0) ? vector : null;
}

function timingFeatures(values) {
  const ordered = [...values].sort((first, second) => first - second);
  return [ordered.length, ordered[0] ?? 0, ordered.at(-1) ?? 0, percentile(ordered, 0.5), percentile(ordered, 0.9)];
}

function percentile(ordered, fraction) {
  if (!ordered.length) return 0;
  const position = (ordered.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower);
}

function pathLength(tree, vector, depth = 0) {
  if (!tree.left || !tree.right) return depth + averagePathLengthFor(tree.size);
  return pathLength(vector[tree.feature] < tree.threshold ? tree.left : tree.right, vector, depth + 1);
}

function averagePathLengthFor(size) {
  if (size <= 1) return 0;
  if (size === 2) return 1;
  return 2 * (Math.log(size - 1) + 0.5772156649) - (2 * (size - 1)) / size;
}

function round(value) {
  return Math.round(value * 100) / 100;
}
