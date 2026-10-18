// Records the plant's lines (src/plant/voice.json) with Amazon Polly into public/voice/<face>.pcm:
// raw 16-bit little-endian mono at 16 kHz, what Polly's PCM output is. The browser upsamples to the
// firmware's 24 kHz before sending. Rerun after changing a line; needs the AWS CLI signed in:
//   npm run plant-voice            (AWS_PROFILE defaults to pineagent)
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const config = JSON.parse(await readFile(fileURLToPath(new URL("../src/plant/voice.json", import.meta.url)), "utf8"));
const dir = fileURLToPath(new URL("../public/voice/", import.meta.url));
await mkdir(dir, { recursive: true });

const profile = process.env.AWS_PROFILE ?? "pineagent";
const only = process.argv.slice(2); // optional: just these faces
for (const [face, text] of Object.entries(config.lines)) {
  if (only.length && !only.includes(face)) continue;
  const out = `${dir}${face}.pcm`;
  // Polly's neural voices are in us-east-1; the rest of the stack is in us-east-2.
  execFileSync("aws", [
    "--profile", profile, "--region", "us-east-1", "polly", "synthesize-speech",
    "--engine", "neural", "--voice-id", config.voice, "--output-format", "pcm", "--sample-rate", "16000",
    "--text", text, out,
  ], { stdio: ["ignore", "ignore", "inherit"] });
  const pcm = trim(await readFile(out));
  await writeFile(out, pcm);
  console.log(`${face.padEnd(18)} ${(pcm.length / 32000).toFixed(2)} s  “${text}”`);
}

// Polly pads each clip with silence; the plant should answer right away. Keeps 30 ms either side.
function trim(buf) {
  const samples = new Int16Array(buf.buffer, buf.byteOffset, buf.length >> 1);
  const loud = (i) => Math.abs(samples[i]) > 400;
  let a = 0, b = samples.length - 1;
  while (a < b && !loud(a)) a++;
  while (b > a && !loud(b)) b--;
  const pad = 480;
  return buf.subarray(Math.max(0, a - pad) * 2, Math.min(samples.length, b + pad) * 2);
}
