(() => {
  const passwordSelector = 'input[type="password"]';
  const activeSessions = new WeakMap();
  const activeFields = new Set();

  function isPasswordField(element) {
    return element instanceof HTMLInputElement && element.matches(passwordSelector);
  }

  function startSession(field) {
    if (activeSessions.has(field)) return activeSessions.get(field);
    const session = {
      keyDownTimes: [],
      lastKeyDownAt: null,
      lastKeyUpAt: null,
      keyHoldDurations: [],
      keyTransitionDurations: [],
      firstCharacterAt: null,
      lastCharacterAt: null,
      insertedCount: 0,
      backspaceCount: 0,
      lastValueLength: field.value.length
    };
    activeSessions.set(field, session);
    activeFields.add(field);
    return session;
  }

  function onKeyDown(event) {
    if (!isPasswordField(event.target)) return;
    const session = startSession(event.target);
    const now = performance.now();
    // Transition time is specifically the previous key release to this key press.
    if (session.lastKeyUpAt !== null) {
      session.keyTransitionDurations.push(Math.max(0, now - session.lastKeyUpAt));
    }
    session.lastKeyDownAt = now;
    // Store timestamps only; key identity is never retained.
    session.keyDownTimes.push(now);
  }

  function onKeyUp(event) {
    if (!isPasswordField(event.target)) return;
    const session = activeSessions.get(event.target);
    if (!session || !session.keyDownTimes.length) return;
    const now = performance.now();
    const downAt = session.keyDownTimes.shift();
    session.keyHoldDurations.push(Math.max(0, now - downAt));
    session.lastKeyUpAt = now;
  }

  function onInput(event) {
    if (!isPasswordField(event.target)) return;
    const field = event.target;
    const session = startSession(field);
    const delta = field.value.length - session.lastValueLength;
    if (delta > 0) {
      session.insertedCount += delta;
      // Keydown marks the first/last password character without retaining it.
      const characterAt = session.lastKeyDownAt ?? performance.now();
      session.firstCharacterAt ??= characterAt;
      session.lastCharacterAt = characterAt;
    } else if (delta < 0) {
      // Each deletion input is one backspace/delete action; no key name or value is observed.
      session.backspaceCount += 1;
    }
    session.lastValueLength = field.value.length;
  }

  function finishSession(field) {
    const session = activeSessions.get(field);
    if (!session) return;
    activeSessions.delete(field);
    activeFields.delete(field);
    if (session.insertedCount === 0) return;

    const summary = {
      // Raw durations are retained per session; key identity and password content are never retained.
      keyHoldDurations: session.keyHoldDurations.map(round),
      keyTransitionDurations: session.keyTransitionDurations.map(round),
      passwordEntryDurationMs: Math.round(Math.max(0, session.lastCharacterAt - session.firstCharacterAt)),
      backspaceCount: session.backspaceCount
    };
    sendSummary(summary);
  }

  function sendSummary(summary) {
    try {
      const pending = chrome.runtime.sendMessage({ type: "password-typing-summary", summary });
      if (pending?.catch) pending.catch(() => { });
    } catch (_error) {
      // Discard a summary if an extension reload invalidated this content script.
    }
  }

  function finishAllSessions() {
    [...activeFields].forEach((field) => finishSession(field));
  }

  function round(value) {
    return Math.round(value * 10) / 10;
  }

  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("keyup", onKeyUp, true);
  document.addEventListener("input", onInput, true);
  document.addEventListener("focusout", (event) => {
    if (isPasswordField(event.target)) finishSession(event.target);
  }, true);
  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (form instanceof HTMLFormElement) {
      [...form.querySelectorAll(passwordSelector)].forEach((field) => finishSession(field));
    }
  }, true);
  window.addEventListener("pagehide", finishAllSessions, true);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") finishAllSessions();
  }, true);
})();
