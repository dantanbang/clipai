// Parses transcripts (plain or timestamped) and locates verbatim quotes in them.

const BRACKETED = /^\s*[\[(](\d{1,2}:\d{2}(?::\d{2})?)[\])]\s*[-–—:]?\s*(.*)$/;
const BARE = /^\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*[-–—]?\s+(.*)$/;
const MIN_QUOTE_CHARS = 8;

function toSeconds(t) {
  const p = t.split(":").map(Number);
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
}

// Lowercase, strip punctuation, collapse whitespace. Applied to BOTH the
// transcript and the quote, so differences in punctuation/case don't matter.
export function normalizeForMatch(s) {
  return String(s)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function parseLine(raw) {
  const m = raw.match(BRACKETED) ?? raw.match(BARE);
  return m ? { time: m[1], body: m[2] } : { time: null, body: raw };
}

export function parseTranscript(text) {
  const lines = [];
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const { time, body } = parseLine(raw);
    lines.push({
      index: lines.length,
      time,
      seconds: time ? toSeconds(time) : null,
      text: body.trim(),
      norm: normalizeForMatch(body),
    });
  }
  let joined = "";
  const starts = [];
  for (const l of lines) {
    starts.push(joined.length);
    joined += l.norm + " ";
  }
  return { lines, joined, starts, hasTimestamps: lines.some((l) => l.time) };
}

/** Does the (normalized) text appear in the transcript as whole words? */
export function containsText(parsed, s) {
  const q = normalizeForMatch(s);
  if (!q) return true;
  return (" " + parsed.joined).includes(" " + q + " ");
}

/**
 * Find a verbatim quote (ignoring case/punctuation). Whole words only, and it
 * may span line breaks. Returns { found, lineIndex, time } or { found:false, reason }.
 */
export function findQuote(parsed, quote) {
  const q = normalizeForMatch(quote ?? "");
  if (q.length < MIN_QUOTE_CHARS) return { found: false, reason: "quote too short" };

  const idx = (" " + parsed.joined).indexOf(" " + q + " ");
  if (idx === -1) return { found: false, reason: "quote not found in transcript" };

  let lineIndex = 0;
  for (let i = parsed.starts.length - 1; i >= 0; i--) {
    if (parsed.starts[i] <= idx) {
      lineIndex = i;
      break;
    }
  }
  return { found: true, lineIndex, time: parsed.lines[lineIndex]?.time ?? null };
}