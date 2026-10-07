// ClipAI device permission page (Phase 6)
// Offscreen documents can't show permission prompts, so the user grants
// microphone / camera access here once. Chrome then remembers it for the
// extension's origin, and the offscreen document can use the device silently.
//
// Opened as permission.html?device=microphone  or  permission.html?device=camera

const device =
  new URLSearchParams(location.search).get("device") === "camera"
    ? "camera"
    : "microphone";

const constraints =
  device === "camera" ? { video: true } : { audio: true };

const msg = document.getElementById("msg");
const retry = document.getElementById("btn-retry");

document.getElementById("title").textContent = `ClipAI needs ${device} access`;
document.getElementById("intro").innerHTML =
  `Chrome will ask for permission to use your ${device}. Choose <b>Allow</b>.`;
retry.textContent = `Allow ${device}`;

function setMsg(text, cls = "") {
  msg.textContent = text;
  msg.className = cls;
}

async function closeSelf() {
  const tab = await chrome.tabs.getCurrent();
  if (tab) chrome.tabs.remove(tab.id);
}

async function requestAccess() {
  setMsg(`Requesting ${device} access...`);
  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    stream.getTracks().forEach((t) => t.stop()); // we only needed the grant
    setMsg(
      `${device[0].toUpperCase() + device.slice(1)} access granted. You can turn it on in ClipAI now. This tab will close.`,
      "ok"
    );
    setTimeout(closeSelf, 1500);
  } catch (err) {
    if (err.name === "NotAllowedError") {
      setMsg(
        `${device[0].toUpperCase() + device.slice(1)} access was denied or dismissed. Click the button to try again. ` +
          `If Chrome no longer shows a prompt, open chrome://settings/content/${device} and remove ` +
          `chrome-extension://${chrome.runtime.id} from the Blocked list.`,
        "error"
      );
    } else if (err.name === "NotFoundError") {
      setMsg(`No ${device} was found. Connect one and try again.`, "error");
    } else if (err.name === "NotReadableError") {
      setMsg(`The ${device} is in use by another application.`, "error");
    } else {
      setMsg(`Could not access the ${device}: ${err.message}`, "error");
    }
  }
}

retry.addEventListener("click", requestAccess);
requestAccess(); // ask immediately on load