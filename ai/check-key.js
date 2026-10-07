const k = process.env.ANTHROPIC_API_KEY;

if (!k) {
  console.log("ANTHROPIC_API_KEY is NOT set in this terminal.");
} else {
  console.log("Length:", k.length);
  console.log("Starts with:", JSON.stringify(k.slice(0, 7)));
  console.log("Ends with:", JSON.stringify(k.slice(-2)));
  console.log("Has quotes:", /["']/.test(k));
  console.log("Has leading/trailing whitespace:", k !== k.trim());
}