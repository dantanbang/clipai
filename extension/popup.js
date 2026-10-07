// ClipAI popup (Phase 6)

const $ = (id) => document.getElementById(id);

const els = {
  status: $("status"),
  info: $("info"),
  error: $("error"),
  start: $("btn-start"),
  pause: $("btn-pause"),
  resume: $("btn-resume"),
  stop: $("btn-stop"),
  preview: $("btn-preview"),
  reset: $("btn-reset"),
};

// permission name -> UI elements + storage key
const devices = {
  microphone: {
    chk: $("chk-mic"),
    status: $("mic-status"),
    help: $("mic-help"),
    grant: $("btn-grant-mic"),
    key: "micEnabled",
  },
  camera: {
    chk: $("chk-camera"),
    status: $("camera-status"),
    help: $("camera-help"),
    grant: $("btn-grant-camera"),
    key: "cameraEnabled",
  },
};

// ---------- Device permissions ----------

async function queryPermission(name) {
  try {
    return await navigator.permissions.query({ name });
  } catch {
    return null;
  }
}
const stateOf = (p) => (p ? p.state : "prompt"); // "granted" | "prompt" | "denied"

function openPermissionPage(name) {
  chrome.tabs.create({
    url: chrome.runtime.getURL(`permission.html?device=${name}`),
  });
}

async function refreshDeviceUi(name) {
  const d = devices[name];
  const p = await queryPermission(name);
  if (p) p.onchange = () => refreshDeviceUi(name); // live update while popup is open
  const perm = stateOf(p);

  d.help.textContent = "";
  d.grant.hidden = true;

  if (!d.chk.checked) {
    d.status.textContent = "Off";
    return;
  }
  if (perm === "granted") {
    d.status.textContent = "Access: allowed";
  } else if (perm === "denied") {
    d.status.textContent = "Access: blocked";
    d.help.textContent =
      `Chrome is blocking the ${name} for ClipAI. Open chrome://settings/content/${name}, ` +
      `remove chrome-extension://${chrome.runtime.id} from the Blocked list, then try again.`;
  } else {
    d.status.textContent = "Access: not granted yet";
    d.grant.hidden = false;
  }
}

for (const [name, d] of Object.entries(devices)) {
  d.chk.addEventListener("change", async () => {
    await chrome.storage.local.set({ [d.key]: d.chk.checked });
    await refreshDeviceUi(name);
    if (d.chk.checked && stateOf(await queryPermission(name)) === "prompt") {
      openPermissionPage(name); // ticking the box starts the grant flow
    }
  });
  d.grant.addEventListener("click", () => openPermissionPage(name));
}

// ---------- Rendering ----------

function render(state) {
  const s = state.status;
  els.status.textContent = s;
  els.info.textContent = state.info || "";
  els.error.textContent = state.error || "";

  const idleLike = ["IDLE", "COMPLETED", "ERROR"].includes(s);
  els.start.disabled = !idleLike;
  els.pause.disabled = s !== "RECORDING";
  els.resume.disabled = s !== "PAUSED";
  els.stop.disabled = !["RECORDING", "PAUSED"].includes(s);
  els.preview.disabled = !(s === "COMPLETED" && state.recording);
  els.reset.disabled = !["COMPLETED", "ERROR"].includes(s);

  // Device choices are fixed once recording starts.
  for (const d of Object.values(devices)) d.chk.disabled = !idleLike;
}

async function send(action, extra = {}) {
  try {
    const res = await chrome.runtime.sendMessage({
      type: "COMMAND",
      action,
      ...extra,
    });
    if (!res.ok) els.error.textContent = res.error;
    render(res.state);
  } catch (err) {
    els.error.textContent = `Service worker unreachable: ${err.message}`;
  }
}

async function onStart() {
  els.error.textContent = "";
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    els.error.textContent = "No active tab found.";
    return;
  }

  // Refuse to start if an enabled device isn't permitted yet.
  for (const [name, d] of Object.entries(devices)) {
    if (!d.chk.checked) continue;
    const perm = stateOf(await queryPermission(name));
    if (perm !== "granted") {
      await refreshDeviceUi(name);
      els.error.textContent =
        perm === "denied"
          ? `The ${name} is blocked. See the instructions above, or turn it off.`
          : `${name[0].toUpperCase() + name.slice(1)} access isn't granted yet. Click the Grant button, or turn it off.`;
      return;
    }
  }

  send("START", {
    tabId: tab.id,
    mic: devices.microphone.chk.checked,
    camera: devices.camera.chk.checked,
  });
}

els.start.addEventListener("click", onStart);
els.pause.addEventListener("click", () => send("PAUSE"));
els.resume.addEventListener("click", () => send("RESUME"));
els.stop.addEventListener("click", () => send("STOP"));
els.reset.addEventListener("click", () => send("RESET"));
els.preview.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("preview.html") });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "STATE_UPDATE") render(message.state);
});

// ---------- Init ----------

(async () => {
  const saved = await chrome.storage.local.get(["micEnabled", "cameraEnabled"]);
  devices.microphone.chk.checked = Boolean(saved.micEnabled);
  devices.camera.chk.checked = Boolean(saved.cameraEnabled);
  await Promise.all(Object.keys(devices).map(refreshDeviceUi));
  await send("GET_STATE");
})();