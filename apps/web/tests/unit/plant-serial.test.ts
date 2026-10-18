import { describe, expect, it } from "vitest";
import { PlantBridge } from "../../src/plant/bridge";
import { PlantSerial, type SerialLike, type SerialPortLike } from "../../src/plant/serial";

const OPTS = { timeoutMs: 50, settleMs: 0 };
const enc = new TextEncoder();
const dec = new TextDecoder();

// A robot on a USB cable: answers each line the way PlantBotTest.ino does, unless `reply` says otherwise.
// A reply can be delayed, the way the firmware only answers SERVO WAVE once the arms are back.
type Reply = string | null | [string, number];
function robot(reply: (line: string) => Reply = firmware) {
  const got: string[] = [];
  let toHost!: ReadableStreamDefaultController<Uint8Array>;
  let buf = "";
  let opened = false;
  const make = () => ({
    readable: new ReadableStream<Uint8Array>({ start: (c) => void (toHost = c) }),
    writable: new WritableStream<Uint8Array>({
      write(chunk) {
        buf += dec.decode(chunk);
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          got.push(line);
          const out = reply(line);
          if (out === null) continue;
          const [text, delay] = Array.isArray(out) ? out : [out, 0];
          const send = () => toHost.enqueue(enc.encode(`${text}\r\n`));
          if (delay) setTimeout(send, delay);
          else queueMicrotask(send);
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
  return "ERR Unknown command";
}
const unpowered = (line: string) => firmware(line, false);

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
    const bot = robot(reply);
    const bridge = new PlantBridge();
    const plant = new PlantSerial(browser(bot.port).serial, bridge, OPTS);
    plant.setPrefs({ sound: true, arms: true });
    await plant.connect();
    await until(() => face(plant) === "idle");
    const from = bot.got.length;
    return { bot, bridge, plant, after: () => bot.got.slice(from) };
  }

  it("a finished run plays the melody and waves the arms, after the face", async () => {
    const { bridge, after } = await connected();
    bridge.update("done");
    await until(() => after().includes("SERVO WAVE"));
    await new Promise((r) => setTimeout(r, 150)); // the wave answers late; it must not time out
    expect(after()).toEqual(["STATE done", "SENSE", "MELODY 30", "SERVO WAVE"]);
  });

  it("connecting while the plant already shows done doesn't celebrate", async () => {
    const bot = robot();
    const bridge = new PlantBridge();
    bridge.update("done");
    const plant = new PlantSerial(browser(bot.port).serial, bridge, OPTS);
    await plant.connect();
    await until(() => face(plant) === "done");
    await new Promise((r) => setTimeout(r, 20));
    expect(bot.got).toEqual(["PING", "STATE done"]);
  });

  it("without the 5 V supply the piezo plays instead and the arms stay still", async () => {
    const { bridge, plant, after } = await connected(unpowered);
    bridge.update("done");
    await until(() => after().includes("PIEZO CHIRP"));
    await new Promise((r) => setTimeout(r, 20));
    expect(after()).toEqual(["STATE done", "SENSE", "PIEZO CHIRP"]);
    expect(plant.getStatus()).toMatchObject({ state: "on", power: false, problem: undefined });
  });

  it("asking for approval chirps the piezo, which works on USB power alone", async () => {
    const { bridge, after } = await connected();
    bridge.update("awaiting_approval");
    await until(() => after().includes("PIEZO CHIRP"));
    expect(after()).toEqual(["STATE awaiting_approval", "PIEZO CHIRP"]);
  });

  it("sound and arms can each be turned off", async () => {
    const { bridge, plant, after } = await connected();
    plant.setPrefs({ sound: false });
    bridge.update("done");
    await until(() => after().includes("SERVO WAVE"));
    await new Promise((r) => setTimeout(r, 150)); // the wave finishes
    plant.setPrefs({ sound: true, arms: false });
    bridge.update("idle");
    await until(() => face(plant) === "idle");
    bridge.update("done");
    await until(() => after().filter((l) => l === "MELODY 30").length === 1);
    await new Promise((r) => setTimeout(r, 150));
    expect(after()).toEqual(["STATE done", "SENSE", "SERVO WAVE", "STATE idle", "STATE done", "SENSE", "MELODY 30"]);
  });

  it("a new face cuts the rest of a celebration short", async () => {
    const { bridge, after } = await connected();
    bridge.update("done");
    await until(() => after().includes("MELODY 30"));
    bridge.update("planning"); // a new run starts while the melody plays
    await until(() => after().includes("STATE planning"));
    await new Promise((r) => setTimeout(r, 150));
    expect(after()).toEqual(["STATE done", "SENSE", "MELODY 30", "STATE planning"]);
  });

  it("Celebrate plays the done cue without changing the face", async () => {
    const { plant, after } = await connected();
    await plant.test("done");
    expect(after()).toEqual(["SENSE", "MELODY 30", "SERVO WAVE"]);
    expect(face(plant)).toBe("idle");
  });
});
