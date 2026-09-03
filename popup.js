import { clearDatabase, getSessions, saveMultipleSessions } from "./db.js";

const stats = document.querySelector("#stats");
const clearButton = document.querySelector("#clear");
const exportButton = document.querySelector("#export");
const importButton = document.querySelector("#import");
const importFileInput = document.querySelector("#import-file");

const MAX_SESSIONS = 200;

async function render() {
  const sessions = await getSessions();
  stats.replaceChildren();
  add("Kaydedilen oturum", String(sessions.length));
  if (sessions.length) {
    const recent = sessions.slice(0, 3);
    add("Son oturumlar", recent[0]?.anomalous ? "Son oturum anormal" : "Son oturum normal");
    add("Son giriş süresi", formatMs(recent[0]?.passwordEntryDurationMs));
    add("Son girişte silme", String(recent[0]?.backspaceCount ?? 0));
    add("Son oturum ham ölçümleri", `${recent[0]?.keyHoldDurations?.length ?? 0} basılı tutma, ${recent[0]?.keyTransitionDurations?.length ?? 0} geçiş`);
  }
}

function add(label, value) {
  const dt = document.createElement("dt");
  const dd = document.createElement("dd");
  dt.textContent = label;
  dd.textContent = value;
  stats.append(dt, dd);
}

function formatMs(value) {
  return value === null ? "Yeterli veri yok" : `${Math.round(value)} ms`;
}

clearButton.addEventListener("click", async () => {
  await clearDatabase();
  render();
});

exportButton.addEventListener("click", async () => {
  const payload = JSON.stringify({ sessions: await getSessions() });
  const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "password-anomaly-sessions.json";
  link.click();
  URL.revokeObjectURL(url);
});

importButton.addEventListener("click", () => {
  importFileInput.click();
});

importFileInput.addEventListener("change", (event) => {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const payload = JSON.parse(e.target.result);
      const sessions = payload.sessions || payload;
      if (Array.isArray(sessions)) {
        await saveMultipleSessions(sessions, MAX_SESSIONS);
        // Inform the background worker to update its session count and potentially train
        const currentData = await chrome.storage.local.get("totalSessionsCollected");
        await chrome.storage.local.set({ totalSessionsCollected: (currentData.totalSessionsCollected || 0) + sessions.length });
        await chrome.runtime.sendMessage({ type: "sessions-imported" });
      } else {
        alert("Geçersiz JSON formatı: 'sessions' dizisi bulunamadı.");
      }
    } catch (err) {
      alert("Dosya okuma hatası: " + err.message);
    }
    render();
    importFileInput.value = ""; // reset for next time
  };
  reader.readAsText(file);
});

render();
