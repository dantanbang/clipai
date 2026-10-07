# ClipAI

An AI-powered screen recorder (Loom-style) built as a Chrome Manifest V3 extension, plus a Node module that turns a transcript of a bug demonstration into a structured, evidence-checked bug report.

```
extension/   Chrome extension: tab capture, mic, webcam, pause/resume, preview, download
ai/          Node module: transcript -> bug report (uses the Claude API)
```

## 1. Chrome extension

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select the `extension/` folder.
3. Open a normal web page, click the ClipAI icon, then **Start Recording**.
4. Microphone / Camera: tick the box once. A tab opens and Chrome asks for access. Click **Allow**.
5. **Stop**, then **Open Preview**. Download the screen file (and the camera file, if the camera was on).

Notes:
- `chrome://` pages and the Chrome Web Store can't be captured.
- The webcam is recorded as a **separate file** and overlaid in the preview. It is not burned into the screen file.
- The extension needs **no API key**.

## 2. AI module (bug report from a recording)

Requires **Node 18 or newer** (`node -v`).

### Add YOUR OWN API key (required)

The AI features call the Anthropic (Claude) API. **No key is included in this repository. You must add your own.**

1. Create a key at https://console.anthropic.com (**API Keys**). API usage is billed separately; a claude.ai subscription does not include API access.
2. In the `ai/` folder, copy the example file:
```
   # Windows PowerShell
   Copy-Item .env.example .env
   # macOS / Linux
   cp .env.example .env
```
3. Open `.env` in a text editor (save as **UTF-8**) and replace the placeholder:
```
   ANTHROPIC_API_KEY=sk-ant-...your-key...
```
   No quotes and no spaces.
4. Check the setup:
```
   cd ai
   node check-setup.js
```
   You should see `Anthropic API reachable`.

`.env` is listed in `.gitignore`, so it is never committed. **Never paste a key into code, an issue, or the extension.**

### Use it

```
cd ai
node test-verify.js                                   # offline self-test, needs no key
node run.js                                           # built-in sample transcripts (live API)
node bugreport-cli.js samples/login-bug.txt           # bug report from a transcript file
node bugreport-cli.js ../path/to/clipai-screen.webm   # from a recording (needs a transcription key, below)
```

The bug report is printed as Markdown and saved next to the input as `*.bugreport.md` and `*.bugreport.json`.

### Transcribing audio (optional, separate key)

Claude cannot transcribe audio. To go straight from a `.webm` recording to a report, add a speech-to-text key to `ai/.env`:

```
OPENAI_API_KEY=sk-...your-key...
```

This uses OpenAI's `whisper-1` transcription API (25 MB file limit). If you don't want that, transcribe the recording any way you like, save it as a text file (ideally with `[mm:ss]` timestamps at the start of lines), and pass the `.txt` file to `bugreport-cli.js`.

### How "no made-up details" is enforced

- The model must attach an **exact quote from the transcript** to every claim.
- The code checks each quote really exists in the transcript, and rejects claims that contain numbers, URLs or ALL-CAPS codes that the transcript never mentions.
- Claims that fail are removed and listed under `verification.claimsDropped`. Missing information is reported as `Insufficient information from recording.`
- This guarantees the *evidence* is real. It cannot prove the *interpretation* is right, so read the quotes shown in the report.

## Troubleshooting

| Problem | Fix |
|---|---|
| `No Anthropic API key found` | `.env` is missing or still has the placeholder. See "Add YOUR OWN API key". |
| `401 ... invalid x-api-key` | Wrong or revoked key. Create a new one. |
| `404 ... model` | Set `CLIPAI_MODEL=<a model your account can use>` in `.env`. |
| `.env` seems ignored | It must be in `ai/`, saved as UTF-8 (not UTF-16, which PowerShell's `>` creates). |
| Extension: mic/camera "not granted" | Re-run the grant flow from the popup. Moving the extension folder changes its ID, so you must grant again. |

## Known limitations

- Downloaded WebM files have no duration header (a `MediaRecorder` limitation), so some players show no total length. Fix with `ffmpeg -i in.webm -c copy out.webm`.
- Webcam burn-in (a single file with the bubble baked in) is not implemented; combine the two files with ffmpeg if you need that.