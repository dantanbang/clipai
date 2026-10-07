// Minimal .env loader (no dependencies). Real environment variables win over .env.
// Importing this file loads ai/.env if it exists.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), ".env");

let text = "";
try {
  text = readFileSync(file, "utf8").replace(/^\uFEFF/, ""); // drop BOM if present
} catch {
  // no .env file: fine, the environment may already have the keys
}

for (const line of text.split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const m = t.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!m) continue;
  const value = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  if (process.env[m[1]] === undefined) process.env[m[1]] = value;
}