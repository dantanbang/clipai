// Offline tests: no API key, no network.  Run: node test-verify.js
import assert from "node:assert/strict";
import { INSUFFICIENT } from "./constants.js";
import { parseTranscript, findQuote } from "./transcript.js";
import { verifyReport, renderMarkdown, emptyReport } from "./bugReport.js";
import { processRecording, insufficientResult } from "./processRecording.js";
import { getApiKey, MissingApiKeyError } from "./llm.js";

const TRANSCRIPT = [
  "[00:00] Hi, I'm going to show a bug on the login page.",
  "[00:05] I open the login page on the staging site.",
  "[00:09] I type my email and my password, and the password is definitely correct.",
  "[00:15] Now I click the Login button.",
  "[00:18] And nothing happens. There's no error message and no loading spinner.",
  "[00:24] It should log me in and take me to the dashboard.",
  "[00:30] I tried it twice and got the same result.",
].join("\n");

// Simulated model output that stays faithful to the transcript.
const GOOD = {
  isBugReport: true,
  title: { text: "Login button not responding", evidence: "And nothing happens." },
  description: {
    text: "Clicking Login does nothing, with no error message and no loading spinner.",
    evidence: "There's no error message and no loading spinner.",
  },
  stepsToReproduce: [
    { text: "Open the login page on the staging site", evidence: "I open the login page on the staging site" },
    { text: "Type email and password (the password is correct)", evidence: "I type my email and my password" },
    { text: "Click the Login button", evidence: "Now I click the Login button" },
  ],
  expectedBehavior: {
    text: "The user should be logged in and taken to the dashboard.",
    evidence: "It should log me in and take me to the dashboard",
  },
  actualBehavior: { text: "Nothing happens.", evidence: "And nothing happens" },
  severity: {
    level: "Medium",
    text: "Login does not work, reproduced twice.",
    evidence: "I tried it twice and got the same result",
  },
  technicalObservations: [
    { text: "No error message is shown.", evidence: "no error message" },
    { text: "No loading spinner appears.", evidence: "no loading spinner" },
    { text: "The issue reproduced on a second attempt.", evidence: "I tried it twice and got the same result" },
  ],
};

// Simulated model output with INVENTED details that must be removed.
const BAD = {
  isBugReport: true,
  title: { text: "Login button not responding", evidence: "And nothing happens." },
  description: {
    text: "The login API returns HTTP 500 after clicking Login.",
    evidence: "the login API returns a 500", // never said
  },
  stepsToReproduce: [
    { text: "Open Chrome DevTools", evidence: "I open the dev tools" }, // never said
    { text: "Click the Login button", evidence: "Now I click the Login button" }, // real
  ],
  expectedBehavior: {
    text: "User is redirected to /dashboard (HTTP 302).", // real quote, invented HTTP 302
    evidence: "take me to the dashboard",
  },
  actualBehavior: { text: "Nothing happens.", evidence: "And nothing happens" }, // real
  severity: {
    level: "Critical",
    text: "Users can never log in.",
    evidence: "this blocks every customer", // never said
  },
  technicalObservations: [
    { text: "Console shows error ERR_CONNECTION_REFUSED.", evidence: "no error message" }, // invented code
    { text: "No loading spinner appears.", evidence: "no loading spinner" }, // real
  ],
};

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n        ${e.message}`);
  }
}

const parsed = parseTranscript(TRANSCRIPT);

await test("parseTranscript: timestamp formats", () => {
  const p = parseTranscript(
    ["[00:12] hello world", "00:12 - hello again", "1:02:03 hi there", "(00:45) test line", "plain line"].join("\n")
  );
  assert.deepEqual(p.lines.map((l) => l.time), ["00:12", "00:12", "1:02:03", "00:45", null]);
  assert.deepEqual(p.lines.map((l) => l.seconds), [12, 12, 3723, 45, null]);
});

await test("findQuote: ignores case and punctuation, returns time", () => {
  const f = findQuote(parsed, "AND NOTHING HAPPENS!!!");
  assert.equal(f.found, true);
  assert.equal(f.time, "00:18");
});

await test("findQuote: quote may span lines", () => {
  const f = findQuote(parsed, "I click the Login button And nothing happens");
  assert.equal(f.found, true);
  assert.equal(f.time, "00:15");
});

await test("findQuote: whole words only, short quotes rejected", () => {
  assert.equal(findQuote(parsed, "ogin page").found, false);
  assert.equal(findQuote(parsed, "the").found, false);
  assert.equal(findQuote(parsed, "the server crashed badly").found, false);
});

await test("verifyReport: faithful output passes untouched", () => {
  const v = verifyReport(GOOD, parsed);
  assert.equal(v.title, "Login button not responding");
  assert.equal(v.stepsToReproduce.length, 3);
  assert.equal(v.stepsToReproduce[0].time, "00:05");
  assert.equal(v.severity.level, "Medium");
  assert.equal(v.technicalObservations.length, 3);
  assert.equal(v.verification.claimsDropped.length, 0);
  assert.deepEqual(v.verification.missing, []);
});

await test("verifyReport: invented details are removed", () => {
  const v = verifyReport(BAD, parsed);
  assert.equal(v.title, "Login button not responding"); // real
  assert.equal(v.description, INSUFFICIENT); // fake quote
  assert.equal(v.stepsToReproduce.length, 1); // fake step dropped
  assert.equal(v.stepsToReproduce[0].step, "Click the Login button");
  assert.equal(v.expectedBehavior.text, INSUFFICIENT); // "HTTP 302" not in transcript
  assert.equal(v.actualBehavior.text, "Nothing happens.");
  assert.equal(v.severity.level, INSUFFICIENT); // fake quote
  assert.equal(v.technicalObservations.length, 1); // ERR_CONNECTION_REFUSED dropped
  assert.equal(v.verification.claimsDropped.length, 5);
  for (const f of ["description", "expectedBehavior", "severity"]) {
    assert.ok(v.verification.missing.includes(f), `missing should include ${f}`);
  }
});

await test("verifyReport: non-bug recording gives an all-insufficient report", () => {
  const v = verifyReport({ isBugReport: false }, parsed);
  assert.deepEqual(v, emptyReport(false));
});

await test("verifyReport: garbage model output cannot crash or sneak through", () => {
  const v = verifyReport({ isBugReport: true, title: 42, stepsToReproduce: "nope" }, parsed);
  assert.equal(v.title, INSUFFICIENT);
  assert.deepEqual(v.stepsToReproduce, []);
});

await test("renderMarkdown: contains verified content with timestamps", () => {
  const md = renderMarkdown(verifyReport(GOOD, parsed));
  assert.ok(md.includes("# Login button not responding"));
  assert.ok(md.includes("1. Open the login page on the staging site _(00:05)_"));
  assert.ok(md.includes("**Severity:** Medium"));
});

await test("processRecording: tiny transcript returns insufficient with no API call", async () => {
  assert.deepEqual(await processRecording("Um, so, yeah."), insufficientResult());
});

await test("getApiKey: missing or placeholder keys give a clear error", () => {
  assert.throws(() => getApiKey({ apiKey: "" }), MissingApiKeyError);
  assert.throws(() => getApiKey({ apiKey: "your-anthropic-api-key-here" }), MissingApiKeyError);
  assert.equal(getApiKey({ apiKey: "sk-ant-test-123" }), "sk-ant-test-123");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log("\n--- Rendered report from the faithful (simulated) model output ---\n");
  console.log(renderMarkdown(verifyReport(GOOD, parsed)));
}
process.exit(failed ? 1 : 0);