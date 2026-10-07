// Usage:
//   node bugreport-cli.js samples/login-bug.txt        (transcript text file)
//   node bugreport-cli.js ../recording.webm            (audio/video; needs OPENAI_API_KEY)
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateBugReport, renderMarkdown } from "./bugReport.js";
import { transcribeFile } from "./transcribe.js";
import { MissingApiKeyError } from "./llm.js";

const MEDIA_EXT = new Set([
  ".webm", ".mp4", ".mp3", ".mpeg", ".mpga", ".wav", ".m4a", ".ogg", ".flac",
]);

const input = process.argv[2];
if (!input) {
  console.error("Usage: node bugreport-cli.js <transcript.txt | recording.webm>");
  process.exit(1);
}

try {
  const base = input.replace(/\.[^.\\/]+$/, "");
  let transcript;

  if (MEDIA_EXT.has(path.extname(input).toLowerCase())) {
    console.log(`Transcribing ${input} ...`);
    transcript = await transcribeFile(input);
    await writeFile(`${base}.transcript.txt`, transcript, "utf8");
    console.log(`Transcript saved to ${base}.transcript.txt (check it for mistakes).\n`);
  } else {
    transcript = await readFile(input, "utf8");
  }

  console.log("Generating bug report ...\n");
  const report = await generateBugReport(transcript);
  const markdown = renderMarkdown(report);

  await writeFile(`${base}.bugreport.json`, JSON.stringify(report, null, 2), "utf8");
  await writeFile(`${base}.bugreport.md`, markdown, "utf8");

  console.log(markdown);
  console.log(`Saved: ${base}.bugreport.md and ${base}.bugreport.json`);
} catch (err) {
  console.error(`\n${err instanceof MissingApiKeyError ? "" : "Error: "}${err.message}`);
  process.exit(1);
}