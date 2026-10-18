// Records the plant's lines (src/plant/voice.json) into public/voice/<face>.pcm: raw 16-bit
// little-endian mono at 16 kHz. The browser upsamples to the firmware's 24 kHz before sending.
// Rerun after changing a line:
//   npm run plant-voice                    all lines
//   npm run plant-voice -- done error      just these faces
//
// With ELEVENLABS_API_KEY set (in apps/web/.env.local, which is gitignored, or the environment) it
// uses ElevenLabs with voice.json's "elevenlabs" voice; otherwise Amazon Polly with "voice", through
// the AWS CLI (AWS_PROFILE defaults to pineagent).
//   npm run plant-voice -- --voices        lists the ElevenLabs voices on the account
// The key is only sent to api.elevenlabs.io; it is never printed or written anywhere.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const config = JSON.parse(await readFile(fileURLToPath(new URL("../src/plant/voice.json", import.meta.url)), "utf8"));
const dir = fileURLToPath(new URL("../public/voice/", import.meta.url));
await mkdir(dir, { recursive: true });

const key = process.env.ELEVENLABS_API_KEY?.trim();
const args = process.argv.slice(2);

if (args.includes("--voices")) {
  if (!key) throw new Error("Set ELEVENLABS_API_KEY in apps/web/.env.local first.");
  const { voices } = await eleven("/v1/voices").then((r) => r.json());
  for (const v of voices) {
    const l = v.labels ?? {};
    console.log(`${v.voice_id}  ${v.name.padEnd(24)} ${[l.gender, l.age, l.accent, l.description ?? l.descriptive].filter(Boolean).join(", ")}`);
  }
  console.log('\nPut the one you want in src/plant/voice.json: "elevenlabs": { "voiceId": "…" }');
  process.exit(0);
}

if (key && !config.elevenlabs?.voiceId) {
  throw new Error('ELEVENLABS_API_KEY is set but voice.json has no "elevenlabs": { "voiceId" }. Run with --voices to pick one.');
}
const speaker = key ? `ElevenLabs ${config.elevenlabs.voiceId} (${config.elevenlabs.model ?? "eleven_multilingual_v2"})` : `Polly ${config.voice}`;
console.log(`recording with ${speaker}`);

const profile = process.env.AWS_PROFILE ?? "pineagent";
for (const [face, text] of Object.entries(config.lines)) {
  if (args.length && !args.includes(face)) continue;
  const out = `${dir}${face}.pcm`;
  if (key) {
    const res = await eleven(`/v1/text-to-speech/${config.elevenlabs.voiceId}?output_format=pcm_16000`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, model_id: config.elevenlabs.model ?? "eleven_multilingual_v2", voice_settings: config.elevenlabs.settings }),
    });
    await writeFile(out, Buffer.from(await res.arrayBuffer()));
  } else {
    // Polly's neural voices are in us-east-1; the rest of the stack is in us-east-2.
    execFileSync("aws", [
      "--profile", profile, "--region", "us-east-1", "polly", "synthesize-speech",
      "--engine", "neural", "--voice-id", config.voice, "--output-format", "pcm", "--sample-rate", "16000",
      "--text", text, out,
    ], { stdio: ["ignore", "ignore", "inherit"] });
  }
  const pcm = trim(await readFile(out));
  await writeFile(out, pcm);
  console.log(`${face.padEnd(18)} ${(pcm.length / 32000).toFixed(2)} s  “${text}”`);
}

async function eleven(path, init = {}) {
  const res = await fetch(`https://api.elevenlabs.io${path}`, { ...init, headers: { ...init.headers, "xi-api-key": key } });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res;
}

// TTS pads each clip with silence; the plant should answer right away. Keeps 30 ms either side.
function trim(buf) {
  const samples = new Int16Array(buf.buffer, buf.byteOffset, buf.length >> 1);
  const loud = (i) => Math.abs(samples[i]) > 400;
  let a = 0, b = samples.length - 1;
  while (a < b && !loud(a)) a++;
  while (b > a && !loud(b)) b--;
  const pad = 480;
  return buf.subarray(Math.max(0, a - pad) * 2, Math.min(samples.length, b + pad) * 2);
}
