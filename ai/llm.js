// ClipAI LLM access: Claude via the Anthropic Messages API (no SDK needed).
import "./loadEnv.js";

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
export const DEFAULT_MODEL = "claude-sonnet-5-5"; // override with CLIPAI_MODEL
const REQUEST_TIMEOUT_MS = 90_000;
const PLACEHOLDER_RE = /^your[-_ ]|-here$|^paste/i;

export class MissingApiKeyError extends Error {
  constructor(message) {
    super(message);
    this.name = "MissingApiKeyError";
  }
}

export function getApiKey(options = {}) {
  const key = String(options.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "").trim();
  if (!key || PLACEHOLDER_RE.test(key)) {
    throw new MissingApiKeyError(
      "No Anthropic API key found. Copy .env.example to .env, paste your own key as ANTHROPIC_API_KEY, and try again (see README.md)."
    );
  }
  return key;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(apiKey, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": API_VERSION,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    const err = new Error(`Network error calling the Anthropic API: ${e.message}`);
    err.retryable = true;
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let detail = "";
    try {
      const j = await res.json();
      detail = j?.error?.message || JSON.stringify(j);
    } catch {}
    let message = `Anthropic API error ${res.status}: ${detail}`;
    if (res.status === 401) message += " (check ANTHROPIC_API_KEY in ai/.env)";
    const err = new Error(message);
    err.status = res.status;
    err.retryable = res.status === 429 || res.status >= 500;
    // Some models reject a "temperature" parameter; we retry without it.
    err.temperatureRejected =
      res.status === 400 && /temperature/i.test(detail) && body.temperature !== undefined;
    throw err;
  }
  return res.json();
}

async function withRetry(fn, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts || !err.retryable) throw err;
      await sleep(1000 * 2 ** (i - 1)); // 1s, 2s
    }
  }
}

/**
 * Ask Claude to answer through a single tool, so the result is schema-shaped JSON.
 * Returns the tool input object.
 */
export async function callStructured({
  system,
  user,
  toolName,
  toolDescription,
  inputSchema,
  options = {},
}) {
  const apiKey = getApiKey(options);
  const model = options.model ?? process.env.CLIPAI_MODEL ?? DEFAULT_MODEL;

  const base = {
    model,
    max_tokens: 4000,
    system,
    tools: [{ name: toolName, description: toolDescription, input_schema: inputSchema }],
    tool_choice: { type: "tool", name: toolName },
    messages: [{ role: "user", content: user }],
  };

  const data = await withRetry(async () => {
    try {
      return await post(apiKey, { ...base, temperature: 0 });
    } catch (err) {
      if (err.temperatureRejected) return post(apiKey, base);
      throw err;
    }
  });

  if (data.stop_reason === "max_tokens") {
    throw new Error("The model's answer was cut off (max_tokens). The transcript may be too long.");
  }
  const block = data.content?.find((b) => b.type === "tool_use" && b.name === toolName);
  if (!block) throw new Error("The model did not return structured output.");
  return block.input;
}

/** Tiny request used by check-setup.js to verify the key and model. */
export async function pingClaude(options = {}) {
  const apiKey = getApiKey(options);
  const model = options.model ?? process.env.CLIPAI_MODEL ?? DEFAULT_MODEL;
  const data = await post(apiKey, {
    model,
    max_tokens: 16,
    messages: [{ role: "user", content: "Reply with the single word OK." }],
  });
  return { model: data.model ?? model };
}