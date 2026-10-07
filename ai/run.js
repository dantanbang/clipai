// Runs the built-in sample transcripts through processRecording (live API).
//   node run.js                    -> all samples
//   node run.js my-transcript.txt  -> your own transcript file
import { readFile } from "node:fs/promises";
import { processRecording } from "./processRecording.js";
import { MissingApiKeyError } from "./llm.js";

const SAMPLES = {
  "1) clear bug demo": `Hi, I'm going to show a bug on the login page. I open the login page on the staging site. I type my email and my password, and the password is definitely correct. Now I click the Login button. And nothing happens. There's no error message and no loading spinner. It should log me in and take me to the dashboard. I tried it twice and got the same result.`,
  "2) partial bug (details missing)": `Okay, so on the settings page, when I click Save, the whole page freezes for a few seconds. I'm not sure what's causing it.`,
  "3) not a bug (walkthrough)": `Hey team, quick walkthrough of the new onboarding flow. First we collect the user's name, then we ask which workspace they want to join. After that we show the product tour. Sam, can you update the copy on the product tour by Friday? And let's schedule a review for next week.`,
  "4) vague": `So this thing is not working properly, as you can see. It's kind of broken. Let me know what you think.`,
  "5) too short": `Um, so, yeah, this is weird.`,
};

async function runOne(name, text) {
  console.log(`\n===== ${name} =====`);
  console.log(JSON.stringify(await processRecording(text), null, 2));
}

try {
  const file = process.argv[2];
  if (file) {
    await runOne(file, await readFile(file, "utf8"));
  } else {
    for (const [name, text] of Object.entries(SAMPLES)) await runOne(name, text);
  }
} catch (err) {
  console.error(`\n${err instanceof MissingApiKeyError ? "" : "Error: "}${err.message}`);
  process.exit(1);
}