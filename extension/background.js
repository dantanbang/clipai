// ClipAI service worker (Phase 6)

const State = Object.freeze({
  IDLE: "IDLE",
  STARTING: "STARTING",
  RECORDING: "RECORDING",
  PAUSED: "PAUSED",
  STOPPING: "STOPPING",
  COMPLETED: "COMPLETED",
  ERROR: "ERROR",
});

const TRANSITIONS = {
  START: {
    [State.IDLE]: State.STARTING,
    [State.COMPLETED]: State.STARTING,
    [State.ERROR]: State.STARTING,
  },
  PAUSE: { [State.RECORDING]: State.PAUSED },
  RESUME: { [State.PAUSED]: State.RECORDING },
  STOP: {
    [State.RECORDING]: State.STOPPING,
    [State.PAUSED]: State.STOPPING,
  },
  RESET: {
    [State.COMPLETED]: State.IDLE,
    [State.ERROR]: State.IDLE,
  },
};

const DEFAULT_STATE = {
  status: State.IDLE,
  error: null,
  info: null,
  // { blobUrl, size, chunkCount, mimeType, durationMs, mic, micLost,
  //   cameraWanted, cameraNote, camera: { blobUrl, size, mimeType, offsetMs, lost } | null }
  recording: null,
};

// ---------- State ----------

async function getState() {
  const { recState } = await chrome.storage.session.get("recState");
  return recState || { ...DEFAULT_STATE };
}

async function setState(patch) {
  const next = { ...(await getState()), ...patch };
  await chrome.storage.session.set({ recState: next });
  broadcast(next);
  return next;
}

function broadcast(state) {
  chrome.runtime.sendMessage({ type: "STATE_UPDATE", state }).catch(() => {});
}

async function assertTransition(action) {
  const current = await getState();
  if (!TRANSITIONS[action]?.[current.status]) {
    throw new Error(`Cannot ${action} while ${current.status}`);
  }
  return current;
}

async function applyAction(action) {
  const current = await assertTransition(action);
  return setState({ status: TRANSITIONS[action][current.status], error: null });
}

// ---------- Offscreen document ----------

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification:
      "Hold the captured tab, microphone and camera MediaStreams and record them.",
  });
}

async function closeOffscreen() {
  if (await hasOffscreen()) await chrome.offscreen.closeDocument();
}

function sendToOffscreen(action, extra = {}) {
  return chrome.runtime.sendMessage({ target: "offscreen", action, ...extra });
}

// ---------- Helpers ----------

function friendlyError(err) {
  const msg = err?.message || String(err);
  // Device errors are already user-friendly; don't let the generic
  // "permission denied" rule below overwrite them.
  if (/microphone|camera/i.test(msg)) return msg;
  if (/not been invoked|activeTab/i.test(msg)) {
    return "Chrome blocked capture of this tab. Open ClipAI on a normal web page (chrome:// pages and the Web Store can't be captured).";
  }
  if (/active stream/i.test(msg)) {
    return "This tab is already being captured. Stop the other capture first.";
  }
  if (/Permission denied|NotAllowedError/i.test(msg)) {
    return "Capture permission was denied.";
  }
  if (/Receiving end does not exist/i.test(msg)) {
    return "The recorder is no longer running (the offscreen document was closed).";
  }
  return msg;
}

function describeResult(r) {
  const mb = (r.size / 1024 / 1024).toFixed(2);
  const sec = (r.durationMs / 1000).toFixed(1);
  const mic = r.mic ? (r.micLost ? ", mic (lost partway)" : ", mic on") : ", mic off";
  let cam = ", camera off";
  if (r.cameraWanted) {
    if (r.camera) {
      cam = r.camera.lost
        ? ", camera (lost partway, separate file)"
        : ", camera on (separate file)";
    } else {
      cam = ", camera missing";
    }
  }
  return `Recorded ${mb} MB, ${r.chunkCount} chunks, ${sec}s${mic}${cam} (${r.mimeType})`;
}

// ---------- Capture flow ----------

async function startCapture(tabId, mic, camera) {
  await applyAction("START");
  await setState({ recording: null, info: null });
  try {
    await closeOffscreen(); // discard any previous recording

    if (typeof tabId !== "number") throw new Error("No active tab to record.");

    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tabId,
    });

    await ensureOffscreen();
    const res = await sendToOffscreen("START_CAPTURE", {
      streamId,
      mic: Boolean(mic),
      camera: Boolean(camera),
    });
    if (!res?.ok) {
      throw new Error(res?.error || "Offscreen document did not respond.");
    }
    await setState({ status: State.RECORDING, info: res.info });
  } catch (err) {
    await closeOffscreen().catch(() => {});
    await setState({
      status: State.ERROR,
      error: friendlyError(err),
      info: null,
    });
  }
}

async function pauseResume(action, offscreenAction) {
  await assertTransition(action);
  try {
    const res = await sendToOffscreen(offscreenAction);
    if (!res?.ok) throw new Error(res?.error || "Recorder did not respond.");
  } catch (err) {
    if (/Receiving end does not exist/i.test(err.message)) {
      await closeOffscreen().catch(() => {});
      await setState({
        status: State.ERROR,
        info: null,
        error: friendlyError(err),
      });
      return;
    }
    throw err;
  }
  await applyAction(action);
}

async function stopCapture() {
  await applyAction("STOP");
  try {
    const res = await sendToOffscreen("STOP_CAPTURE");
    if (!res?.ok) {
      throw new Error(res?.error || "Offscreen document did not respond.");
    }
    await setState({
      status: State.COMPLETED,
      recording: res.result,
      info: describeResult(res.result),
    });
  } catch (err) {
    await closeOffscreen().catch(() => {});
    await setState({
      status: State.ERROR,
      error: friendlyError(err),
      info: null,
      recording: null,
    });
  }
}

async function resetAll() {
  await applyAction("RESET");
  await closeOffscreen().catch(() => {});
  await setState({ status: State.IDLE, info: null, recording: null, error: null });
}

async function handleOffscreenEvent(message) {
  const { status } = await getState();
  const active = [State.STARTING, State.RECORDING, State.PAUSED].includes(status);
  const recordingNow = status === State.RECORDING || status === State.PAUSED;

  switch (message.event) {
    case "STREAM_ENDED": {
      if (!active) return;
      const result = message.result;
      if (result && result.size > 0) {
        await setState({
          status: State.COMPLETED,
          recording: result,
          error: null,
          info: `Capture ended early (tab closed or capture revoked). Saved partial recording. ${describeResult(result)}`,
        });
      } else {
        await closeOffscreen().catch(() => {});
        await setState({
          status: State.ERROR,
          info: null,
          error:
            "Capture ended unexpectedly (the tab was closed or capture was revoked) before any data was recorded.",
        });
      }
      break;
    }
    case "MIC_LOST": {
      if (recordingNow) {
        await setState({
          info: "Warning: microphone disconnected. Recording continues with tab audio only.",
        });
      }
      break;
    }
    case "CAMERA_LOST": {
      if (recordingNow) {
        await setState({
          info: "Warning: camera disconnected. Screen recording continues; the camera file will end early.",
        });
      }
      break;
    }
    case "RECORDER_ERROR": {
      if (!active) return;
      await closeOffscreen().catch(() => {});
      await setState({
        status: State.ERROR,
        info: null,
        error: `Recording error: ${message.message || "unknown"}`,
      });
      break;
    }
    default:
      console.debug("[offscreen event]", message.event);
  }
}

// ---------- Message routing ----------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "OFFSCREEN_EVENT") {
    handleOffscreenEvent(message);
    return;
  }
  if (message?.type !== "COMMAND") return;

  (async () => {
    try {
      switch (message.action) {
        case "GET_STATE":
          break;
        case "START":
          await startCapture(message.tabId, message.mic, message.camera);
          break;
        case "PAUSE":
          await pauseResume("PAUSE", "PAUSE_CAPTURE");
          break;
        case "RESUME":
          await pauseResume("RESUME", "RESUME_CAPTURE");
          break;
        case "STOP":
          await stopCapture();
          break;
        case "RESET":
          await resetAll();
          break;
        default:
          throw new Error(`Unknown action: ${message.action}`);
      }
      sendResponse({ ok: true, state: await getState() });
    } catch (err) {
      sendResponse({ ok: false, error: err.message, state: await getState() });
    }
  })();

  return true;
});

chrome.runtime.onStartup.addListener(() => {
  chrome.storage.session.set({ recState: { ...DEFAULT_STATE } });
});
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.session.set({ recState: { ...DEFAULT_STATE } });
});