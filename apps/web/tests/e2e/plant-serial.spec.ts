import { expect, test, type Page } from "@playwright/test";
import { startMock } from "../../mock/server";

// The real robot over Web Serial, with a fake robot standing in for navigator.serial: it answers
// like PlantBotTest.ino (`PING` → `OK PONG …`, `STATE <face>` → `OK …`, the 5 V supply plugged in)
// and records every line.
process.env.MOCK_AVATARS = "0";

function fakeRobot() {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const w = window as unknown as { __robot: string[]; __unplug(): void; __replug(): void };
  w.__robot = [];
  let toHost: ReadableStreamDefaultController<Uint8Array> | null = null;
  let buf = new Uint8Array(0);
  let audioLeft = 0; // bytes of SAY audio still to come; they aren't lines
  let streams: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> } | null = null;
  const port = {
    async open() {
      streams = {
        readable: new ReadableStream<Uint8Array>({ start: (c) => void (toHost = c) }),
        writable: new WritableStream<Uint8Array>({
          write(chunk) {
            const joined = new Uint8Array(buf.length + chunk.length);
            joined.set(buf);
            joined.set(chunk, buf.length);
            buf = joined;
            const reply = (out: string) => setTimeout(() => toHost?.enqueue(enc.encode(`${out}\r\n`)), 5);
            for (;;) {
              if (audioLeft) {
                const take = Math.min(audioLeft, buf.length);
                if (!take) break;
                audioLeft -= take;
                buf = buf.subarray(take);
                if (!audioLeft) reply("OK SAY played");
                continue;
              }
              const i = buf.indexOf(10);
              if (i < 0) break;
              const line = dec.decode(buf.subarray(0, i));
              buf = buf.subarray(i + 1);
              w.__robot.push(line);
              const say = /^SAY (\d+)$/.exec(line);
              if (say && Number(say[1]) > 0) {
                audioLeft = Number(say[1]);
                continue;
              }
              reply(
                line === "PING" ? "OK PONG plantbot-test v1"
                : line.startsWith("STATE ") ? `OK ANIM ${line.slice(6)}`
                : line === "SENSE" ? "OK SENSE mv=3100 power=yes"
                : line === "SAY 0" ? "OK SAY ready rate=24000"
                : /^(MELODY|SERVO|PIEZO|TONE) /.test(line) ? `OK ${line} done`
                : "ERR Unknown",
              );
            }
          },
        }),
      };
    },
    async close() {},
    async setSignals() {},
    getInfo: () => ({ usbVendorId: 0x303a, usbProductId: 0x1001 }),
    get readable() { return streams?.readable ?? null; },
    get writable() { return streams?.writable ?? null; },
  };
  const serial = Object.assign(new EventTarget(), { requestPort: async () => port, getPorts: async () => [] });
  Object.defineProperty(navigator, "serial", { value: serial, configurable: true });
  w.__unplug = () => toHost?.error(new DOMException("The device has been lost.", "NetworkError"));
  w.__replug = () => serial.dispatchEvent(Object.assign(new Event("connect"), { port }));
}

const robot = (p: Page) => p.evaluate(() => (window as unknown as { __robot: string[] }).__robot);
const panel = (p: Page) => p.getByRole("complementary", { name: "Agent runs" });

test("the robot mirrors the plant's faces, and comes back after an unplug", async ({ page }) => {
  const mock = await startMock({ port: 0, runStepMs: 150 });
  try {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.addInitScript(fakeRobot);
    await page.goto(`/?as=alice&api=http://localhost:${mock.port}`);
    await expect(page.getByTestId("connection")).toHaveText("Connected");
    await expect(panel(page).getByRole("status")).toHaveText("Robot not connected");

    await panel(page).getByRole("button", { name: "Connect robot" }).click();
    await expect(panel(page).getByRole("status")).toHaveText("Robot connected · Idle");
    expect(await robot(page)).toEqual(["PING", "STATE idle"]);

    await page.getByLabel("Ask your agent").fill("add a test for currentUser");
    await page.getByRole("button", { name: "Start run" }).click();
    await expect(page.getByTestId("run-state")).toHaveText("done");
    // Finishing celebrates: "Yay! All done!" (the real Polly clip, served by the app), then the arms wave.
    await expect.poll(() => robot(page), { timeout: 15_000 }).toContain("SERVO WAVE");
    const sent = await robot(page);
    const done = sent.indexOf("STATE done");
    const order = ["STATE planning", "STATE executing", "STATE done", "SERVO WAVE"].map((l) => sent.indexOf(l));
    expect(order.every((i) => i > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    const doneLine = sent.slice(done).find((l) => /^SAY [1-9]/.test(l));
    expect(Number(doneLine?.slice(4))).toBeGreaterThan(48_000 * 1.2); // ~1.6 s at 24 kHz, 2 bytes a sample
    await page.screenshot({ path: "test-results/plant-serial.png" });

    // With Sound off, Celebrate only waves.
    await panel(page).getByLabel("Sound").uncheck();
    const before = (await robot(page)).length;
    await panel(page).getByRole("button", { name: "Celebrate" }).click();
    await expect.poll(async () => (await robot(page)).slice(before), { timeout: 10_000 }).toEqual(["SENSE", "SERVO WAVE"]);
    await panel(page).getByLabel("Sound").check();

    await page.evaluate(() => (window as unknown as { __unplug(): void }).__unplug());
    await expect(panel(page).getByRole("alert")).toContainText("Robot unplugged");
    await page.evaluate(() => (window as unknown as { __replug(): void }).__replug());
    await expect(panel(page).getByRole("status")).toHaveText(/^Robot connected/);
    expect((await robot(page)).filter((l) => l === "PING")).toHaveLength(2);

    await panel(page).getByRole("button", { name: "Disconnect" }).click();
    await expect(panel(page).getByRole("status")).toHaveText("Robot not connected");
  } finally {
    await mock.close();
  }
});

test("without Web Serial the panel says which browser to use", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "serial", { value: undefined, configurable: true }));
  const mock = await startMock({ port: 0 });
  try {
    await page.goto(`/?as=alice&api=http://localhost:${mock.port}`);
    await expect(page.getByTestId("connection")).toHaveText("Connected");
    await expect(panel(page)).toContainText("open this page in desktop Chrome or Edge");
    await expect(panel(page).getByRole("button", { name: "Connect robot" })).toHaveCount(0);
  } finally {
    await mock.close();
  }
});
