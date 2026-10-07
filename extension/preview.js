// ClipAI preview page (Phase 6, sync fix)

const $ = (id) => document.getElementById(id);
const els = {
  message: $("message"),
  stage: $("stage"),
  player: $("player"),
  cam: $("cam"),
  meta: $("meta"),
  overlayRow: $("overlay-row"),
  overlayChk: $("chk-overlay"),
  syncRow: $("sync-row"),
  syncRange: $("sync-range"),
  syncVal: $("sync-val"),
  syncReset: $("btn-sync-reset"),
  dlScreen: $("download-screen"),
  dlCam: $("download-cam"),
};

const ownUrls = [];

function show(text, isError = false) {
  els.message.textContent = text;
  els.message.className = isError ? "error" : "";
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(
    d.getHours()
  )}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function fetchBlob(url) {
  const res = await fetch(url);
  return res.blob();
}

function urlFor(blob) {
  const u = URL.createObjectURL(blob);
  ownUrls.push(u);
  return u;
}

// MediaRecorder WebM has no duration header -> duration === Infinity and
// seeking is broken. Seeking far past the end makes Chrome scan the file and
// learn the real duration. Resolves once usable (or after 4s).
function ensureFiniteDuration(video) {
  return new Promise((resolve) => {
    const finish = () => resolve();
    const fix = () => {
      if (video.duration !== Infinity) return finish();
      video.currentTime = 1e101;
      video.addEventListener(
        "timeupdate",
        () => {
          video.addEventListener("seeked", finish, { once: true });
          video.currentTime = 0;
        },
        { once: true }
      );
    };
    if (video.readyState >= 1) fix();
    else video.addEventListener("loadedmetadata", fix, { once: true });
    setTimeout(finish, 4000);
  });
}

// ---------- Camera <-> screen sync ----------
// getOffsetSec(): how many seconds LATER than the screen video the camera
// file starts (measured offset + the user's manual adjustment).
function setupSync(main, cam, getOffsetSec) {
  let timer = null;

  const target = () => main.currentTime - getOffsetSec(); // camera time that matches now
  const camLimit = () => (Number.isFinite(cam.duration) ? cam.duration : Infinity);

  function hardAlign() {
    const t = target();
    cam.playbackRate = main.playbackRate;
    if (t < 0) {
      // Camera hasn't started yet at this point of the screen recording.
      cam.pause();
      cam.currentTime = 0;
      return;
    }
    cam.currentTime = Math.min(t, camLimit());
    if (!main.paused && t < camLimit()) cam.play().catch(() => {});
    else cam.pause();
  }

  function tick() {
    if (main.paused || main.seeking) return;
    const t = target();
    if (t < 0) {
      if (!cam.paused) cam.pause();
      return;
    }
    if (t >= camLimit()) {
      if (!cam.paused) cam.pause(); // camera file ended earlier than the screen
      return;
    }
    if (cam.paused) cam.play().catch(() => {});

    const drift = cam.currentTime - t; // > 0: camera is ahead
    if (Math.abs(drift) > 0.25) {
      cam.currentTime = t; // big error: jump
      cam.playbackRate = main.playbackRate;
    } else if (Math.abs(drift) > 0.04) {
      // small error: gently speed up / slow down instead of seeking
      cam.playbackRate = main.playbackRate * (drift > 0 ? 0.95 : 1.05);
    } else {
      cam.playbackRate = main.playbackRate;
    }
  }

  const startTimer = () => {
    clearInterval(timer);
    timer = setInterval(tick, 100);
  };
  const stopTimer = () => clearInterval(timer);

  main.addEventListener("play", () => {
    hardAlign();
    startTimer();
  });
  main.addEventListener("pause", () => {
    stopTimer();
    cam.pause();
    hardAlign();
  });
  main.addEventListener("ended", () => {
    stopTimer();
    cam.pause();
  });
  main.addEventListener("seeking", hardAlign);
  main.addEventListener("seeked", hardAlign);
  main.addEventListener("ratechange", () => {
    cam.playbackRate = main.playbackRate;
  });

  return { hardAlign };
}

async function init() {
  try {
    const res = await chrome.runtime.sendMessage({
      type: "COMMAND",
      action: "GET_STATE",
    });
    const rec = res?.state?.recording;
    if (!rec?.blobUrl) {
      show("No recording available. Record something first.", true);
      return;
    }

    // ----- Screen recording -----
    let screenBlob;
    try {
      screenBlob = await fetchBlob(rec.blobUrl);
    } catch {
      show(
        "The recording is no longer available (it was reset or the recorder was closed). Record again.",
        true
      );
      return;
    }
    if (!screenBlob.size) {
      show("The recording is empty.", true);
      return;
    }

    const screenUrl = urlFor(screenBlob);
    els.player.addEventListener("error", () => {
      show(
        `Playback error: ${els.player.error?.message || "the file could not be decoded"}`,
        true
      );
    });
    els.player.src = screenUrl;
    els.stage.hidden = false;

    els.dlScreen.href = screenUrl;
    els.dlScreen.download = `clipai-screen-${stamp()}.webm`;
    els.dlScreen.hidden = false;

    const mb = (screenBlob.size / 1024 / 1024).toFixed(2);
    const sec = (rec.durationMs / 1000).toFixed(1);
    let meta = `Screen: ${mb} MB, ${sec}s, ${rec.mimeType}`;

    // ----- Camera recording (optional, separate file) -----
    let camReady = false;
    if (rec.camera?.blobUrl) {
      try {
        const camBlob = await fetchBlob(rec.camera.blobUrl);
        if (camBlob.size) {
          const camUrl = urlFor(camBlob);
          els.cam.src = camUrl;
          els.cam.hidden = false;
          els.overlayRow.hidden = false;
          els.syncRow.hidden = false;

          els.dlCam.href = camUrl;
          els.dlCam.download = `clipai-camera-${stamp()}.webm`;
          els.dlCam.hidden = false;

          const cmb = (camBlob.size / 1024 / 1024).toFixed(2);
          meta += ` | Camera: ${cmb} MB, measured offset ${rec.camera.offsetMs} ms${
            rec.camera.lost ? " (camera lost partway)" : ""
          }`;
          camReady = true;

          await Promise.all([
            ensureFiniteDuration(els.player),
            ensureFiniteDuration(els.cam),
          ]);

          // Manual timing adjustment (remembered between recordings).
          const saved = await chrome.storage.local.get("camAdjustMs");
          let adjustMs = Number(saved.camAdjustMs) || 0;
          els.syncRange.value = String(adjustMs);
          els.syncVal.textContent = `${adjustMs} ms`;

          const sync = setupSync(
            els.player,
            els.cam,
            () => (rec.camera.offsetMs + adjustMs) / 1000
          );

          els.syncRange.addEventListener("input", () => {
            adjustMs = Number(els.syncRange.value);
            els.syncVal.textContent = `${adjustMs} ms`;
            chrome.storage.local.set({ camAdjustMs: adjustMs });
            sync.hardAlign();
          });
          els.syncReset.addEventListener("click", () => {
            els.syncRange.value = "0";
            els.syncRange.dispatchEvent(new Event("input"));
          });
        }
      } catch {
        meta += " | Camera file no longer available.";
      }
    } else if (rec.cameraWanted) {
      meta += ` | Camera missing${rec.cameraNote ? `: ${rec.cameraNote}` : ""}`;
    }

    if (!camReady) await ensureFiniteDuration(els.player);

    els.overlayChk.addEventListener("change", () => {
      els.cam.hidden = !els.overlayChk.checked;
    });

    els.meta.textContent = meta;
    show("Ready.");
  } catch (err) {
    show(`Could not load recording: ${err.message}`, true);
  }
}

window.addEventListener("beforeunload", () => {
  ownUrls.forEach((u) => URL.revokeObjectURL(u));
});

init();