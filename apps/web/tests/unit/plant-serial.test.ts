import { describe, expect, it } from "vitest";
import { PlantBridge } from "../../src/plant/bridge";
import { forFirmware, PlantSerial, type SerialLike, type SerialPortLike } from "../../src/plant/serial";

const CLIP = new Int16Array(160).fill(1000); // 10 ms at 16 kHz → 240 samples, 480 bytes at 24 kHz
let laptop: number[] = []; // clips played on the laptop speaker
const OPTS = {
  timeoutMs: 50,
  settleMs: 0,
  loadClip: async () => CLIP,
  playLocal: async (clip: Int16Array) => void laptop.push(clip.length),
};
const enc = new TextEncoder();
const dec = new TextDecoder();

// A robot on a USB cable: answers each line the way PlantBotTest.ino does, unless `reply` says otherwise.
// A reply can be delayed, the way the firmware only answers SERVO WAVE once the arms are back. After a
// `SAYD k` line the next k bytes are audio, and the answer comes once they've all arrived.
type Reply = string | null | [string, number];
function robot(reply: (line: string) => Reply = firmware) {
  const got: string[] = [];
  const said: number[] = []; // audio bytes received per SAY n
  const chunks: number[] = []; // size of each SAYD
  let toHost!: ReadableStreamDefaultController<Uint8Array>;
  let buf = new Uint8Array(0);
  let audioLeft = 0;
  let afterAudio: Reply = null;
  let opened = false;
  const answer = (out: Reply) => {
    if (out === null) return;
    const [text, delay] = Array.isArray(out) ? out : [out, 0];
    const send = () => toHost.enqueue(enc.encode(`${text}\r\n`));
    if (delay) setTimeout(send, delay);
    else queueMicrotask(send);
  };
  const make = () => ({
    readable: new ReadableStream<Uint8Array>({ start: (c) => void (toHost = c) }),
    writable: new WritableStream<Uint8Array>({
      write(chunk) {
        const joined = new Uint8Array(buf.length + chunk.length);
        joined.set(buf);
        joined.set(chunk, buf.length);
        buf = joined;
        for (;;) {
          if (audioLeft) {
            const take = Math.min(audioLeft, buf.length);
            if (!take) break;
            said[said.length - 1] += take;
            chunks[chunks.length - 1] += take;
            audioLeft -= take;
            buf = buf.subarray(take);
            if (!audioLeft) answer(afterAudio);
            continue;
          }
          const i = buf.indexOf(10);
          if (i < 0) break;
          const line = dec.decode(buf.subarray(0, i));
          buf = buf.subarray(i + 1);
          got.push(line);
          const out = reply(line);
          if (/^SAY [1-9]/.test(line)) said.push(0);
          const k = Number(/^SAYD (\d+)$/.exec(line)?.[1] ?? 0);
          // Firmware that knows SAYD reads the bytes even when it then refuses them.
          if (k > 0 && !String(Array.isArray(out) ? out[0] : out).includes("Unknown command")) {
            audioLeft = k;
            afterAudio = out;
            chunks.push(0);
          } else answer(out);
        }
      },
    }),
  });
  let streams = make();
  const port: SerialPortLike = {
    async open() {
      if (opened) throw Object.assign(new Error("already open"), { name: "InvalidStateError" });
      opened = true;
      streams = make();
      queueMicrotask(() => toHost.enqueue(enc.encode("EVT READY plantbot-test v1\r\n")));
    },
    async close() { opened = false; },
    async setSignals() {},
    getInfo: () => ({ usbVendorId: 0x303a, usbProductId: 0x1001 }),
    get readable() { return streams.readable; },
    get writable() { return streams.writable; },
  };
  return {
    port,
    got,
    said,
    chunks,
    faces: () => got.filter((l) => l.startsWith("STATE ")).map((l) => l.slice(6)),
    isOpen: () => opened,
    unplug: () => toHost.error(Object.assign(new Error("The device has been lost."), { name: "NetworkError" })),
  };
}

function firmware(line: string, power = true): Reply {
  if (line === "PING") return "OK PONG plantbot-test v1";
  if (line.startsWith("STATE ")) return `OK ANIM ${line.slice(6)} playing`;
  if (line === "SENSE") return `OK SENSE mv=${power ? 3100 : 40} power=${power ? "yes" : "no"}`;
  if (/^(MELODY|TONE|SERVO) /.test(line) && !power) return "ERR Servos needs the 5 V brick plugged in (SENSE reads low).";
  if (line === "SERVO WAVE") return ["OK SERVO wave done", 120]; // longer than the 50 ms base timeout
  if (line.startsWith("MELODY ")) return ["OK MELODY done", 40];
  if (/^(MELODY|TONE|PIEZO) /.test(line)) return `OK ${line.split(" ")[0]} done`;
  if (line === "SAY 0") return "OK SAY ready rate=24000 chunk=512";
  if (line === "SAY PLAY") return ["OK SAY played", 40];
  if (/^SAY \d+$/.test(line)) return power ? `OK SAY open ${line.slice(4)}` : "ERR The amp needs the 5 V brick plugged in (SENSE reads low).";
  if (line.startsWith("SAYD ")) return "OK SAYD";
  return "ERR Unknown command";
}
const unpowered = (line: string) => firmware(line, false);
const noSay = (line: string) => (/^SAYD? /.test(line) ? `ERR Unknown command: ${line}. Send HELP for the list.` : firmware(line));

function browser(port: SerialPortLike, granted: SerialPortLike[] = []) {
  const serial = Object.assign(new EventTarget(), {
    requestPort: async () => port,
    getPorts: async () => granted,
  }) as SerialLike;
  return { serial, replug: () => serial.dispatchEvent(Object.assign(new Event("connect"), { port })) };
}

const face = (plant: PlantSerial) => {
  const s = plant.getStatus();
  return s.state === "on" ? s.face : null;
};
const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
};

describe("plant over Web Serial", () => {
  it("is unsupported without Web Serial", () => {
    expect(new PlantSerial(undefined, new PlantBridge(), OPTS).getStatus()).toEqual({ state: "unsupported" });
  });

  it("pings, then shows the face the app is already showing, then each new face", async () => {
    const bot = robot();
    const bridge = new PlantBridge();
    bridge.update("planning");
    const plant = new PlantSerial(browser(bot.port).serial, bridge, OPTS);
    await plant.connect();
    await until(() => face(plant) === "planning");
    expect(bot.got[0]).toBe("PING");
    expect(bot.faces()).toEqual(["planning"]);
    expect(plant.getStatus()).toEqual({ state: "on", face: "planning", problem: undefined, power: null });

    bridge.update("executing");
    await until(() => face(plant) === "executing");
    expect(bot.faces()).toEqual(["planning", "executing"]);
  });

  it("skips faces that went by while one was being sent", async () => {
    const bot = robot();
    const bridge = new PlantBridge();
    const plant = new PlantSerial(browser(bot.port).serial, bridge, OPTS);
    await plant.connect();
    await until(() => face(plant) === "idle");
    // "planning" goes out at once; "routing" is replaced by "executing" before planning's OK comes back.
    bridge.update("planning");
    bridge.update("routing");
    bridge.update("executing");
    await until(() => face(plant) === "executing");
    expect(bot.faces()).toEqual(["idle", "planning", "executing"]);
  });

  it("an ERR shows a problem but keeps the robot connected", async () => {
    const bot = robot((l) => (l.startsWith("STATE ") ? "ERR Unknown face state. Send LCD ANIM LIST." : firmware(l)));
    const plant = new PlantSerial(browser(bot.port).serial, new PlantBridge(), OPTS);
    await plant.connect();
    await until(() => face(plant) === "idle");
    expect(plant.getStatus()).toMatchObject({ state: "on", problem: expect.stringContaining("Unknown face state") });
    expect(bot.isOpen()).toBe(true);
  });

  it("gives up and closes the port when nothing answers PING", async () => {
    const bot = robot(() => null);
    const plant = new PlantSerial(browser(bot.port).serial, new PlantBridge(), OPTS);
    await plant.connect();
    expect(bot.got).toEqual(["PING", "PING", "PING"]);
    expect(plant.getStatus()).toMatchObject({ state: "off", note: expect.stringContaining("No answer") });
    expect(bot.isOpen()).toBe(false);
  });

  it("after an unplug, reconnects when the robot comes back and re-sends the current face", async () => {
    const bot = robot();
    const bridge = new PlantBridge();
    const { serial, replug } = browser(bot.port);
    const plant = new PlantSerial(serial, bridge, OPTS);
    await plant.connect();
    await until(() => bot.faces().length === 1);

    bot.unplug();
    await until(() => plant.getStatus().state === "off");
    expect(plant.getStatus()).toMatchObject({ note: expect.stringContaining("unplugged") });
    bridge.update("awaiting_approval"); // while unplugged: nowhere to send it

    replug();
    await until(() => bot.faces().length === 2);
    expect(bot.faces()).toEqual(["idle", "awaiting_approval"]);
    expect(plant.getStatus()).toMatchObject({ state: "on", face: "awaiting_approval" });
  });

  it("after the user disconnects, a replug doesn't reconnect and faces stop going out", async () => {
    const bot = robot();
    const bridge = new PlantBridge();
    const { serial, replug } = browser(bot.port);
    const plant = new PlantSerial(serial, bridge, OPTS);
    await plant.connect();
    await until(() => bot.faces().length === 1);
    await plant.disconnect();
    expect(plant.getStatus()).toEqual({ state: "off" });
    expect(bot.isOpen()).toBe(false);
    bridge.update("done");
    replug();
    await new Promise((r) => setTimeout(r, 30));
    expect(bot.faces()).toEqual(["idle"]);
  });

  it("resume opens a robot granted on an earlier visit without a click", async () => {
    const bot = robot();
    const plant = new PlantSerial(browser(bot.port, [bot.port]).serial, new PlantBridge(), OPTS);
    await plant.resume();
    await until(() => bot.faces().length === 1);
    expect(plant.getStatus()).toMatchObject({ state: "on" });
  });

  it("a busy port explains itself", async () => {
    const bot = robot();
    bot.port.open = async () => { throw Object.assign(new Error("Failed to open serial port."), { name: "NetworkError" }); };
    const plant = new PlantSerial(browser(bot.port).serial, new PlantBridge(), OPTS);
    await plant.connect();
    expect(plant.getStatus()).toMatchObject({ state: "off", note: expect.stringContaining("busy") });
  });
});

describe("robot cues", () => {
  // Connects, lets the first face go out (it never gets a cue), and returns what's sent from then on.
  async function connected(reply?: (line: string) => Reply) {
    laptop = [];
    const bot = robot(reply);
    const bridge = new PlantBridge();
    const plant = new PlantSerial(browser(bot.port).serial, bridge, OPTS);
    plant.setPrefs({ sound: true, arms: true });
    await plant.connect();
    await until(() => face(plant) === "idle");
    const from = bot.got.length;
    return { bot, bridge, plant, after: () => bot.got.slice(from) };
  }
  const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

  it("a finished run says its line on the robot, then waves the arms", async () => {
    const { bot, bridge, after } = await connected();
    bridge.update("done");
    await until(() => after().includes("SERVO WAVE"));
    await settle(); // the wave answers late; it must not time out
    expect(after()).toEqual(["STATE done", "SENSE", "SAY 0", "SAY 480", "SAYD 480", "SAY PLAY", "SERVO WAVE"]);
    expect(bot.said).toEqual([480]);
    expect(laptop).toEqual([]);
  });

  it("connecting while the plant already shows done doesn't celebrate", async () => {
    const bot = robot();
    const bridge = new PlantBridge();
    bridge.update("done");
    const plant = new PlantSerial(browser(bot.port).serial, bridge, OPTS);
    await plant.connect();
    await until(() => face(plant) === "done");
    await settle(20);
    expect(bot.got).toEqual(["PING", "STATE done"]);
  });

  it("without the 5 V supply the laptop speaks, the piezo stands in for tones, and the arms stay still", async () => {
    const { bridge, plant, after } = await connected(unpowered);
    bridge.update("done");
    await until(() => laptop.length === 1);
    await settle(20);
    expect(after()).toEqual(["STATE done", "SENSE"]);
    expect(plant.getStatus()).toMatchObject({ state: "on", power: false, problem: undefined });

    bridge.update("error");
    await until(() => laptop.length === 2);
    expect(after().slice(2)).toEqual(["STATE error", "SENSE", "PIEZO 700 180", "PIEZO 500 420"]);
  });

  it("firmware without SAY is asked once, then the laptop speaks", async () => {
    const { bridge, after } = await connected(noSay);
    bridge.update("done");
    await until(() => after().includes("SERVO WAVE"));
    await settle();
    bridge.update("idle");
    await until(() => after().includes("STATE idle"));
    bridge.update("done");
    await until(() => after().filter((l) => l === "SERVO WAVE").length === 2);
    expect(after()).toEqual(["STATE done", "SENSE", "SAY 0", "SERVO WAVE", "STATE idle", "STATE done", "SENSE", "SERVO WAVE"]);
    expect(laptop).toEqual([160, 160]);
  });

  it("if the robot refuses a clip, no audio is sent, the laptop says it and the panel says why", async () => {
    // SENSE says yes, but the amp still refuses (say the brick was unplugged in between).
    const { bot, bridge, plant } = await connected((l) => (/^SAY [1-9]/.test(l) ? "ERR The amp needs the 5 V brick plugged in." : firmware(l)));
    bridge.update("paused");
    await until(() => laptop.length === 1);
    expect(plant.getStatus()).toMatchObject({ problem: expect.stringContaining("couldn’t speak") });
    expect(bot.chunks).toEqual([]);
  });

  it("long clips go in chunks no bigger than the robot asks for, all of the audio arriving", async () => {
    const long = new Int16Array(1000).fill(1000); // → 1500 samples, 3000 bytes
    const bot = robot();
    const bridge = new PlantBridge();
    const plant = new PlantSerial(browser(bot.port).serial, bridge, { ...OPTS, loadClip: async () => long });
    plant.setPrefs({ sound: true, arms: false });
    await plant.connect();
    await until(() => face(plant) === "idle");
    bridge.update("done");
    await until(() => bot.got.includes("SAY PLAY"));
    expect(bot.chunks).toEqual([512, 512, 512, 512, 512, 440]);
    expect(bot.said).toEqual([3000]);
    expect(bot.got).toContain("SAY 3000");
  });

  it("the first, unchunked SAY firmware isn't trusted with audio", async () => {
    const { bridge, after } = await connected((l) => (l === "SAY 0" ? "OK SAY ready rate=24000" : firmware(l)));
    bridge.update("paused");
    await until(() => laptop.length === 1);
    expect(after()).toEqual(["STATE paused", "SENSE", "SAY 0"]);
  });

  it("asking for approval chirps the piezo, then asks out loud", async () => {
    const { bridge, after } = await connected();
    bridge.update("awaiting_approval");
    await until(() => after().includes("SAY PLAY"));
    expect(after()).toEqual(["STATE awaiting_approval", "PIEZO CHIRP", "SENSE", "SAY 0", "SAY 480", "SAYD 480", "SAY PLAY"]);
  });

  it("a face that flashes by gets no line", async () => {
    const { bridge, after } = await connected();
    bridge.update("planning");
    await settle(100);
    bridge.update("executing"); // within planning's 300 ms
    await until(() => after().includes("SAY PLAY"));
    expect(after()).toEqual(["STATE planning", "STATE executing", "SENSE", "SAY 0", "SAY 480", "SAYD 480", "SAY PLAY"]);
  });

  it("sound and arms can each be turned off", async () => {
    const { bridge, plant, after } = await connected();
    plant.setPrefs({ sound: false });
    bridge.update("done");
    await until(() => after().includes("SERVO WAVE"));
    await settle(); // the wave finishes
    plant.setPrefs({ sound: true, arms: false });
    bridge.update("idle");
    await until(() => face(plant) === "idle");
    bridge.update("done");
    await until(() => after().includes("SAY PLAY"));
    await settle();
    expect(after()).toEqual(["STATE done", "SENSE", "SERVO WAVE", "STATE idle", "STATE done", "SENSE", "SAY 0", "SAY 480", "SAYD 480", "SAY PLAY"]);
  });

  it("a new face cuts the rest of a celebration short", async () => {
    const { bridge, after } = await connected();
    bridge.update("done");
    await until(() => after().includes("SAY PLAY"));
    bridge.update("blocked"); // something new happens while it speaks
    await until(() => after().includes("STATE blocked"));
    await settle();
    expect(after().slice(0, 7)).toEqual(["STATE done", "SENSE", "SAY 0", "SAY 480", "SAYD 480", "SAY PLAY", "STATE blocked"]);
    expect(after()).not.toContain("SERVO WAVE");
  });

  it("Celebrate plays the done cue without changing the face", async () => {
    const { plant, after } = await connected();
    await plant.test("done");
    expect(after()).toEqual(["SENSE", "SAY 0", "SAY 480", "SAYD 480", "SAY PLAY", "SERVO WAVE"]);
    expect(face(plant)).toBe("idle");
  });

  it("clips are upsampled to the firmware's rate at half volume, little-endian", () => {
    const bytes = forFirmware(new Int16Array([0, 3000, -3000, 1000]), 24000);
    const out = new DataView(bytes.buffer);
    expect(bytes.length).toBe(12); // 4 samples at 16 kHz → 6 at 24 kHz
    expect([0, 1, 2, 3, 4, 5].map((i) => out.getInt16(i * 2, true))).toEqual([0, 1000, 500, -1500, -167, 500]);
  });
});
