// Optional: speech-to-text for audio/video files (Claude cannot transcribe audio).
// Uses OpenAI's whisper-1 transcription API and returns "[mm:ss] text" lines.
import "./loadEnv.js";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const MAX_BYTES = 25 * 1024 * 1024; // API upload limit
const TIMEOUT_MS = 5 * 60_000;
const PLACEHOLDER_RE = /^your[-_ ]|-here$|^paste/i;
const MIME = {
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".mpeg": "audio/mpeg",
  ".mpga": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
};

function fmt(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(r).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export async function transcribeFile(filePath, options = {}) {
  const apiKey = String(options.apiKey ?? process.env.OPENAI_API_KEY ?? "").trim();
  if (!apiKey || PLACEHOLDER_RE.test(apiKey)) {
    throw new Error(
      "No transcription key found. Add OPENAI_API_KEY to ai/.env (see README.md), or pass a ready-made transcript .txt file instead."
    );
  }

  const { size } = await stat(filePath);
  if (size > MAX_BYTES) {
    throw new Error(
      `File is ${(size / 1048576).toFixed(1)} MB; the transcription limit is 25 MB. ` +
        `Extract the audio first, e.g.: ffmpeg -i "${path.basename(filePath)}" -vn -c:a libopus -b:a 32k audio.ogg`
    );
  }

  const ext = path.extname(filePath).toLowerCase();
  const form = new FormData();
  form.append(
    "file",
    new Blob([await readFile(filePath)], { type: MIME[ext] ?? "application/octet-stream" }),
    path.basename(filePath)
  );
  form.append("model", options.model ?? process.env.CLIPAI_TRANSCRIBE_MODEL ?? "whisper-1");
  form.append("response_format", "verbose_json");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal,
    });
  } catch (e) {
    throw new Error(`Network error during transcription: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.json())?.error?.message ?? "";
    } catch {}
    throw new Error(`Transcription API error ${res.status}: ${detail}`);
  }

  const data = await res.json();
  const segments = Array.isArray(data.segments) ? data.segments : [];
  if (segments.length === 0) return String(data.text ?? "").trim();
  return segments.map((s) => `[${fmt(s.start)}] ${String(s.text).trim()}`).join("\n");
}