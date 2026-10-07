// Verifies that your .env / key / model work. Never prints the key.
import { getApiKey, pingClaude, MissingApiKeyError, DEFAULT_MODEL } from "./llm.js";

try {
  const key = getApiKey();
  console.log(`Key found (${key.length} characters, starts with "${key.slice(0, 7)}").`);
  console.log(`Model: ${process.env.CLIPAI_MODEL ?? DEFAULT_MODEL}`);
  const r = await pingClaude();
  console.log(`OK: Anthropic API reachable, model "${r.model}" responded.`);
} catch (err) {
  if (err instanceof MissingApiKeyError) {
    console.error(`\n${err.message}`);
  } else if (err.status === 401) {
    console.error(`\n${err.message}\nThe key was rejected. Create a new one at console.anthropic.com.`);
  } else if (err.status === 404) {
    console.error(`\n${err.message}\nThe model name isn't available to your account. Set CLIPAI_MODEL in .env.`);
  } else if (err.status === 400 && /credit/i.test(err.message)) {
    console.error(`\n${err.message}\nAdd credits in the Anthropic Console (Billing).`);
  } else {
    console.error(`\n${err.message}`);
  }
  process.exit(1);
}