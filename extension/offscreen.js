// ClipAI offscreen document (Phase 6)
// Owns: tab stream, mic stream, camera stream, audio graph,
// TWO MediaRecorders (screen+audio, camera video-only), chunks, Blobs.

const FINALIZE_TIMEOUT_MS = 10000;
const SCREEN_BITS_PER_SECOND = 2_500_000;
const CAMERA_BITS_PER_SECOND = 1_000_000;

let media = null;       // captured tab MediaStream
let micStream = null;   // microphone stream (mic ON)
let camStream = null;   // camera stream (camera ON, video only)
let audioCtx = null;

let recorder = null;    // screen (+ audio) recorder
let camRecorder = null; // camera recorder
let chunks = [];
let camChunks = [];
let blobUrl = null;
let camBlobUrl = null;

let micWanted = false;
let micLost = false;
let camWanted = false;
let camLost = false;

let startedAt = 0;
let pausedAt = 0;
let pausedTotal = 0;
let screenStartMark = 0; // performance.now() when each recorder actually started
let camStartMark = 0;

let finalizePromise = null;
let resolveFinalize = null;
let camFinalizePromise = null;
let resolveCamFinalize = null;
let endedReported = false;

// ---------- Messaging ----------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "offscreen") return;

  (async () => {
    try {
      switch (message.action) {
        case "START_CAPTURE":
          sendResponse({
            ok: true,
            info: await startCapture(
              message.streamId,
              Boolean(message.mic),
              Boolean(message.camera)
            ),
          });
          break;
        case "PAUSE_CAPTURE":
          pauseCapture();
          sendResponse({ ok: true });
          break;
        case "RESUME_CAPTURE":
          resumeCapture();
          sendResponse({ ok: true });
          break;
        case "STOP_CAPTURE":
          sendResponse({ ok: true, result: await stopCapture() });
          break;
        default:
          throw new Error(`Unknown offscreen action: ${message.action}`);
      }
    } catch (err) {
      if (message.action === "START_CAPTURE") discardAll();
      sendResponse({ ok: false, error: describeError(err) });
    }
  })();

  return true;
});

function emit(event, detail = {}) {
  chrome.runtime
    .sendMessage({ type: "OFFSCREEN_EVENT", event, ...detail })
    .catch(() => {});
}

// ---------- Devices ----------

function micErrorMessage(err) {
  switch (err?.name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Microphone permission denied. Click \"Grant microphone access\" in the ClipAI popup, or turn the microphone off.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No microphone found. Connect one, or turn the microphone off.";
    case "NotReadableError":
    case "AbortError":
      return "The microphone is in use by another application or could not be started.";
    default:
      return `Microphone error: ${err?.message || err}`;
  }
}

function cameraErrorMessage(err) {
  switch (err?.name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Camera permission denied. Click \"Grant camera access\" in the ClipAI popup, or turn the camera off.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No camera found. Connect one, or turn the camera off.";
    case "NotReadableError":
    case "AbortError":
      return "The camera is in use by another application or could not be started.";
    default:
      return `Camera error: ${err?.message || err}`;
  }
}

async function acquireMic() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  } catch (err) {
    throw new Error(micErrorMessage(err));
  }
  const track = micStream.getAudioTracks()[0];
  if (!track) {
    throw new Error("Microphone error: the microphone stream has no audio track.");
  }
  track.addEventListener("ended", onMicEnded);
  return track;
}

async function acquireCamera() {
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 30 },
      },
      audio: false, // voice is already in the screen recording's single audio track
    });
  } catch (err) {
    throw new Error(cameraErrorMessage(err));
  }
  const track = camStream.getVideoTracks()[0];
  if (!track) {
    throw new Error("Camera error: the camera stream has no video track.");
  }
  track.addEventListener("ended", onCamEnded);
  return track;
}

function onMicEnded() {
  if (micLost) return;
  micLost = true;
  emit("MIC_LOST");
}

function onCamEnded() {
  if (camLost) return;
  camLost = true;
  emit("CAMERA_LOST"); // camRecorder stops itself; screen recording continues
}

// ---------- Start ----------

function pickMimeType() {
  return [
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=vp9,opus",
    "video/webm",
  ].find((t) => MediaRecorder.isTypeSupported(t));
}

function pickCameraMimeType() {
  return ["video/webm;codecs=vp8", "video/webm;codecs=vp9", "video/webm"].find(
    (t) => MediaRecorder.isTypeSupported(t)
  );
}

function createCameraRecorder(stream) {
  const mimeType = pickCameraMimeType();
  if (!mimeType) throw new Error("Camera error: no supported WebM format found.");

  camChunks = [];
  camFinalizePromise = new Promise((res) => (resolveCamFinalize = res));

  camRecorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: CAMERA_BITS_PER_SECOND,
  });

  camRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) camChunks.push(e.data);
  };
  camRecorder.onstart = () => {
    camStartMark = performance.now();
  };
  camRecorder.onerror = (e) => {
    // A camera failure must not kill the screen recording.
    camLost = true;
    emit("CAMERA_LOST", { reason: e.error?.message || "camera recorder error" });
  };
  camRecorder.onstop = () => {
    const n = camChunks.length;
    const type = camRecorder ? camRecorder.mimeType : mimeType;
    releaseCamera(); // safe now: final data has been flushed

    if (n === 0) {
      resolveCamFinalize({ error: "The camera recording produced no data." });
      return;
    }
    const blob = new Blob(camChunks, { type: "video/webm" });
    camChunks = [];
    if (blob.size === 0) {
      resolveCamFinalize({ error: "The camera recording was empty." });
      return;
    }
    camBlobUrl = URL.createObjectURL(blob);
    resolveCamFinalize({
      blobUrl: camBlobUrl,
      size: blob.size,
      chunkCount: n,
      mimeType: type,
      // How much later (+) or earlier (-) the camera started vs. the screen.
      offsetMs:
        camStartMark && screenStartMark
          ? Math.round(camStartMark - screenStartMark)
          : 0,
    });
  };
}

async function startCapture(streamId, wantMic, wantCamera) {
  if (media) throw new Error("A capture is already running.");
  if (!streamId) throw new Error("Invalid stream: missing stream ID.");
  if (typeof MediaRecorder === "undefined") {
    throw new Error("MediaRecorder is not supported in this browser.");
  }
  const mimeType = pickMimeType();
  if (!mimeType) throw new Error("No supported WebM recording format found.");

  discardAll();
  endedReported = false;
  micWanted = wantMic;
  micLost = false;
  camWanted = wantCamera;
  camLost = false;
  screenStartMark = 0;
  camStartMark = 0;

  // 1. Tab stream
  media = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId },
    },
    video: {
      mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId },
    },
  });

  const videoTracks = media.getVideoTracks();
  const tabAudioTracks = media.getAudioTracks();
  if (videoTracks.length === 0) {
    throw new Error("Invalid stream: no video track was captured.");
  }

  // 2. Devices (fail cleanly: discardAll() releases everything acquired so far)
  const micTrack = wantMic ? await acquireMic() : null;
  const camTrack = wantCamera ? await acquireCamera() : null;

  // 3. Audio graph (unchanged from Phase 5)
  let recordStream = media; // mic OFF: record the tab's original tracks as-is

  if (tabAudioTracks.length > 0 || micTrack) {
    audioCtx = new AudioContext();
    if (audioCtx.state === "suspended") {
      await audioCtx.resume().catch(() => {});
    }
  }

  let tabSource = null;
  if (tabAudioTracks.length > 0) {
    tabSource = audioCtx.createMediaStreamSource(new MediaStream(tabAudioTracks));
    tabSource.connect(audioCtx.destination); // keep the tab audible
  }

  if (micTrack) {
    // Chrome's MediaRecorder only keeps ONE audio track, so mix tab + mic.
    const mixDest = audioCtx.createMediaStreamDestination();
    if (tabSource) tabSource.connect(mixDest);
    audioCtx
      .createMediaStreamSource(new MediaStream([micTrack]))
      .connect(mixDest); // mic is NOT played back, to avoid feedback
    recordStream = new MediaStream([
      ...videoTracks,
      ...mixDest.stream.getAudioTracks(),
    ]);
  }

  media.getTracks().forEach((t) => t.addEventListener("ended", onTrackEnded));

  // 4. Screen recorder
  chunks = [];
  pausedAt = 0;
  pausedTotal = 0;
  finalizePromise = new Promise((res) => (resolveFinalize = res));

  recorder = new MediaRecorder(recordStream, {
    mimeType,
    videoBitsPerSecond: SCREEN_BITS_PER_SECOND,
  });

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  recorder.onstart = () => {
    screenStartMark = performance.now();
    emit("RECORDER_STARTED");
  };
  recorder.onpause = () => {
    pausedAt = Date.now();
    emit("RECORDER_PAUSED");
  };
  recorder.onresume = () => {
    if (pausedAt) pausedTotal += Date.now() - pausedAt;
    pausedAt = 0;
    emit("RECORDER_RESUMED");
  };
  recorder.onerror = (e) => {
    emit("RECORDER_ERROR", {
      message: e.error?.message || e.error?.name || "MediaRecorder error",
    });
  };
  recorder.onstop = () => {
    emit("RECORDER_STOPPED");

    const now = Date.now();
    const currentPause = pausedAt ? now - pausedAt : 0;
    const durationMs = Math.max(0, now - startedAt - pausedTotal - currentPause);
    pausedAt = 0;

    const chunkCount = chunks.length;
    releaseStream(); // tab + mic + audio graph (camera releases itself)

    if (chunkCount === 0) {
      resolveFinalize({ error: "Recording produced no data." });
      return;
    }
    const blob = new Blob(chunks, { type: "video/webm" });
    chunks = [];
    if (blob.size === 0) {
      resolveFinalize({ error: "Recording produced an empty file." });
      return;
    }
    blobUrl = URL.createObjectURL(blob);
    resolveFinalize({
      blobUrl,
      size: blob.size,
      chunkCount,
      mimeType: recorder.mimeType,
      durationMs,
      mic: micWanted,
      micLost,
    });
  };

  // 5. Camera recorder (separate file, video only)
  if (camTrack) createCameraRecorder(camStream);

  // Start both in the same tick; real start times are measured in onstart.
  startedAt = Date.now();
  recorder.start(1000);
  if (camRecorder) camRecorder.start(1000);

  const s = videoTracks[0].getSettings();
  return (
    `Recording: ${s.width ?? "?"}x${s.height ?? "?"} @ ${Math.round(s.frameRate ?? 0)}fps, ` +
    `tab audio ${tabAudioTracks.length ? "yes" : "no"}, mic ${micTrack ? "on" : "off"}, ` +
    `camera ${camTrack ? "on (separate file)" : "off"}, ` +
    `${recordStream.getAudioTracks().length} audio track(s) in screen file, ${recorder.mimeType}`
  );
}

// ---------- Pause / Resume (both recorders together) ----------

function pauseCapture() {
  if (!recorder || recorder.state !== "recording") {
    throw new Error("Cannot pause: the recorder is not recording.");
  }
  recorder.pause();
  if (camRecorder && camRecorder.state === "recording") camRecorder.pause();
}

function resumeCapture() {
  if (!recorder || recorder.state !== "paused") {
    throw new Error("Cannot resume: the recorder is not paused.");
  }
  recorder.resume();
  if (camRecorder && camRecorder.state === "paused") camRecorder.resume();
}

// ---------- Results ----------

// Waits for the screen recording, then for the camera recording.
// A camera problem never fails the screen recording.
async function collectResult() {
  const screen = await finalizePromise;
  if (screen?.error) return screen;

  let camera = null;
  let cameraNote = null;
  if (camFinalizePromise) {
    const c = await camFinalizePromise;
    if (c?.error) cameraNote = c.error;
    else camera = { ...c, lost: camLost };
  }
  return { ...screen, camera, cameraWanted: camWanted, cameraNote };
}

// ---------- Stop ----------

function stopRecorders() {
  // Camera first, so its final chunk is flushed before anything else is released.
  if (camRecorder && camRecorder.state !== "inactive") camRecorder.stop();
  if (recorder && recorder.state !== "inactive") recorder.stop();
}

async function stopCapture() {
  if (!recorder || !finalizePromise) {
    throw new Error("No active recording to stop.");
  }
  stopRecorders();

  const timeout = new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error("Timed out while finalizing the recording.")),
      FINALIZE_TIMEOUT_MS
    )
  );
  const result = await Promise.race([collectResult(), timeout]);
  if (result?.error) throw new Error(result.error);
  return result;
}

// ---------- Unexpected end of the TAB stream ----------

async function onTrackEnded() {
  if (endedReported) return;
  endedReported = true;
  try {
    stopRecorders();
    const result = await collectResult();
    emit("STREAM_ENDED", { result: result?.error ? null : result });
  } catch {
    emit("STREAM_ENDED", { result: null });
  }
}

// ---------- Cleanup ----------

function releaseStream() {
  if (media) {
    media.getTracks().forEach((t) => {
      t.removeEventListener("ended", onTrackEnded);
      t.stop();
    });
    media = null;
  }
  if (micStream) {
    micStream.getTracks().forEach((t) => {
      t.removeEventListener("ended", onMicEnded);
      t.stop();
    });
    micStream = null;
  }
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }
}

function releaseCamera() {
  if (camStream) {
    camStream.getTracks().forEach((t) => {
      t.removeEventListener("ended", onCamEnded);
      t.stop();
    });
    camStream = null;
  }
}

function discardAll() {
  for (const r of [recorder, camRecorder]) {
    if (!r) continue;
    r.ondataavailable = null;
    r.onstop = null;
    r.onerror = null;
    r.onstart = null;
    r.onpause = null;
    r.onresume = null;
    if (r.state !== "inactive") {
      try { r.stop(); } catch {}
    }
  }
  recorder = null;
  camRecorder = null;

  releaseStream();
  releaseCamera();

  chunks = [];
  camChunks = [];
  if (blobUrl) {
    URL.revokeObjectURL(blobUrl);
    blobUrl = null;
  }
  if (camBlobUrl) {
    URL.revokeObjectURL(camBlobUrl);
    camBlobUrl = null;
  }
  finalizePromise = null;
  resolveFinalize = null;
  camFinalizePromise = null;
  resolveCamFinalize = null;
}

function describeError(err) {
  // Errors we threw ourselves (device, invalid stream, ...) are already friendly.
  if (err instanceof Error && err.name === "Error") return err.message;

  const name = err?.name || "Error";
  if (name === "NotAllowedError") return "Capture permission was denied by Chrome.";
  if (name === "NotReadableError" || name === "AbortError") {
    return "The tab could not be captured (it may already be captured, or the stream ID expired).";
  }
  if (name === "NotSupportedError") return "This recording format is not supported.";
  return err?.message || String(err);
}