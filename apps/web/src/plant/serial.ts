import type { FaceKey } from "../runs/runs";
import { plantBridge, type PlantSink } from "./bridge";
import { CUES } from "./cues";

// The browser-to-robot link (LLD 9) over Web Serial, speaking the test firmware's line protocol:
// one command per line, exactly one `OK …` or `ERR …` line back. Other lines (EVT …, CSI telemetry)
// are not answers and are skipped. Connection steps follow firmware/PlantBotTestKit/PlantBot-TestBench.html.

// The slice of the Web Serial API used here (TypeScript's DOM types don't include it).
export interface SerialPortLike {
  open(options: { baudRate: number; bufferSize?: number }): Promise<void>;
  close(): Promise<void>;
  setSignals?(signals: { dataTerminalReady?: boolean; requestToSend?: boolean }): Promise<void>;
  getInfo(): { usbVendorId?: number; usbProductId?: number };
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
}
export interface SerialLike extends EventTarget {
  requestPort(options?: { filters?: { usbVendorId?: number }[] }): Promise<SerialPortLike>;
  getPorts(): Promise<SerialPortLike[]>;
}
type BridgeLike = { attach(sink: PlantSink): () => void };

export type PlantSerialStatus =
  | { state: "unsupported" }
  | { state: "off"; note?: string }
  | { state: "connecting" }
  | { state: "on"; face: FaceKey | null; problem?: string; power: boolean | null }; // power: 5 V supply seen, null until asked

// Sounds and arm moves can each be turned off (a quiet room, a robot without arms fitted).
export type PlantPrefs = { sound: boolean; arms: boolean };
const PREFS_KEY = "pineagent.robot";

const ESPRESSIF = 0x303a; // the S3's native USB port, the one the firmware answers on
const BAUD = 115200; // native USB ignores it, but open() needs one

type Link = {
  port: SerialPortLike;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  writer: WritableStreamDefaultWriter<Uint8Array>;
};
type Pending = { resolve: (rest: string) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export class PlantSerial {
  private status: PlantSerialStatus;
  private readonly listeners = new Set<() => void>();
  private link: Link | null = null;
  private port: SerialPortLike | null = null; // the robot to come back to after a replug; null once the user disconnects
  private pending: Pending | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private detach: (() => void) | null = null;
  private wanted: FaceKey | null = null;
  private sent: FaceKey | null = null;
  private pumping = false;
  private power: boolean | null = null;
  private prefs: PlantPrefs = loadPrefs();
  private testing = false;

  constructor(
    private readonly serial: SerialLike | undefined,
    private readonly bridge: BridgeLike,
    private readonly opts = { timeoutMs: 1500, settleMs: 600 },
  ) {
    this.status = serial ? { state: "off" } : { state: "unsupported" };
    serial?.addEventListener("connect", (e) => void this.replugged(e));
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getStatus = () => this.status;
  getPrefs = () => this.prefs;

  setPrefs(patch: Partial<PlantPrefs>) {
    this.prefs = { ...this.prefs, ...patch };
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs)); } catch { /* storage blocked: still applies to this page */ }
    this.listeners.forEach((fn) => fn());
  }

  // Plays a face's cue without changing the face, to check the speaker, piezo and arms.
  async test(face: FaceKey = "done") {
    if (!this.link || this.testing) return;
    this.testing = true;
    try {
      await this.cue(face, this.wanted);
    } finally {
      this.testing = false;
    }
  }

  // Needs a click: Chrome only shows the port chooser from a user gesture.
  async connect() {
    if (!this.serial || this.link) return;
    let port: SerialPortLike;
    try {
      port = await this.serial.requestPort({ filters: [{ usbVendorId: ESPRESSIF }] });
    } catch {
      return; // chooser cancelled
    }
    await this.open(port);
  }

  // A port granted on an earlier visit opens without a click, so a reload picks the robot back up.
  async resume() {
    if (!this.serial || this.link) return;
    const [port] = (await this.serial.getPorts()).filter((p) => p.getInfo().usbVendorId === ESPRESSIF);
    if (port) await this.open(port, { quiet: true });
  }

  async disconnect() {
    this.port = null;
    await this.teardown();
    this.set({ state: "off" });
  }

  private async open(port: SerialPortLike, { quiet = false } = {}) {
    this.set({ state: "connecting" });
    try {
      await port.open({ baudRate: BAUD, bufferSize: 8192 });
    } catch (e) {
      // Chrome says NetworkError when another program (or tab) already has the port open.
      const busy = e instanceof Error && e.name === "NetworkError";
      const note = busy ? "The robot’s port is busy. Close the test bench, serial monitor or other tab using it." : `Couldn’t open the robot’s port: ${(e as Error).message}`;
      this.set({ state: "off", note: quiet ? undefined : note });
      return;
    }
    // The S3's USB-JTAG reset logic watches DTR/RTS, so keep RTS low.
    try { await port.setSignals?.({ dataTerminalReady: true, requestToSend: false }); } catch { /* not every port supports it */ }
    const link: Link = { port, reader: port.readable!.getReader(), writer: port.writable!.getWriter() };
    this.link = link;
    void this.readLoop(link);

    if (!(await this.handshake())) {
      await this.teardown();
      this.set({ state: "off", note: "No answer from the robot. Is it on the USB port, with the plant firmware flashed?" });
      return;
    }
    this.port = port;
    this.sent = null;
    this.power = null;
    this.on(null);
    // Attaching hands over the current face at once, which is also the re-send after a replug.
    this.detach = this.bridge.attach({ show: (face) => this.show(face) });
  }

  private async handshake() {
    for (let i = 0; i < 3; i++) {
      try {
        if ((await this.command("PING")).startsWith("PONG")) return true;
      } catch {
        if (!this.link) return false;
      }
    }
    return false;
  }

  private show(face: FaceKey) {
    this.wanted = face;
    void this.pump();
  }

  // Sends only the newest face: if several arrive while one is in flight, the in-between ones are skipped.
  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.link && this.wanted && this.wanted !== this.sent) {
        const face = this.wanted;
        const first = this.sent === null; // what it was already showing when the robot connected: no fanfare
        let problem: string | undefined;
        try {
          await this.command(`STATE ${face}`);
        } catch (e) {
          if (!this.link) return;
          problem = `The robot couldn’t show “${face}”: ${(e as Error).message}`;
        }
        this.sent = face; // an ERR isn't retried; the next face change tries again
        this.on(face, problem);
        if (!first) await this.cue(face, face);
      }
    } finally {
      this.pumping = false;
    }
  }

  // Plays the steps the user has left on. Stops early if the plant moves on from `during`, so the
  // face isn't held back behind a celebration that no longer applies.
  private async cue(face: FaceKey, during: FaceKey | null) {
    const steps = (CUES[face] ?? []).filter((s) => this.prefs[s.kind]);
    if (!steps.length) return;
    if (steps.some((s) => s.power)) await this.sense();
    for (const step of steps) {
      if (!this.link || this.wanted !== during) return;
      const cmd = step.power && this.power === false ? step.piezo : step.cmd;
      if (!cmd) continue;
      try {
        await this.command(cmd, step.ms + this.opts.timeoutMs);
      } catch (e) {
        if (!this.link) return;
        this.on(this.sent, `The robot couldn’t do “${cmd}”: ${(e as Error).message}`);
      }
    }
  }

  // Asks the firmware whether the 5 V supply is in. It can be plugged in or out at any time.
  private async sense() {
    try {
      this.power = /power=yes/.test(await this.command("SENSE"));
    } catch {
      this.power = null;
    }
    if (this.status.state === "on") this.on(this.status.face, this.status.problem);
  }

  private on(face: FaceKey | null, problem?: string) {
    this.set({ state: "on", face, problem, power: this.power });
  }

  // One command in flight at a time, so each answer belongs to the command before it.
  private command(line: string, timeoutMs = this.opts.timeoutMs): Promise<string> {
    const run = this.chain.then(() => this.exchange(line, timeoutMs));
    this.chain = run.catch(() => {});
    return run;
  }

  private exchange(line: string, timeoutMs: number): Promise<string> {
    const link = this.link;
    if (!link) return Promise.reject(new Error("not connected"));
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new Error("no answer"));
      }, timeoutMs);
      this.pending = { resolve, reject, timer };
      link.writer.write(new TextEncoder().encode(`${line}\n`)).catch(() => {});
    });
  }

  private async readLoop(link: Link) {
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await link.reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          this.answer(buf.slice(0, i).trim());
          buf = buf.slice(i + 1);
        }
        if (buf.length > 4096) buf = "";
      }
    } catch {
      // unplugged or reset: the read fails
    }
    if (this.link === link) await this.lost();
  }

  private answer(line: string) {
    const p = this.pending;
    const ok = line.startsWith("OK ") || line === "OK";
    if (!p || !(ok || line.startsWith("ERR"))) return;
    this.pending = null;
    clearTimeout(p.timer);
    if (ok) p.resolve(line.slice(3));
    else p.reject(new Error(line.replace(/^ERR\s*/, "")));
  }

  private async lost() {
    await this.teardown();
    this.set({ state: "off", note: this.port ? "Robot unplugged. Plug it back in and it reconnects." : undefined });
  }

  private async replugged(e: Event) {
    const back = ((e as Event & { port?: SerialPortLike }).port ?? e.target) as SerialPortLike;
    const was = this.port;
    if (!was || this.link || this.status.state === "connecting") return;
    const a = back.getInfo?.() ?? {}, b = was.getInfo();
    if (back !== was && !(a.usbVendorId === b.usbVendorId && a.usbProductId === b.usbProductId)) return;
    await new Promise((r) => setTimeout(r, this.opts.settleMs)); // let the board finish booting
    if (!this.link) await this.open(back);
  }

  private async teardown() {
    const link = this.link;
    if (!link) return;
    this.link = null;
    this.detach?.();
    this.detach = null;
    this.sent = null;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error("disconnected"));
      this.pending = null;
    }
    try { await link.reader.cancel(); } catch { /* already gone */ }
    try { link.reader.releaseLock(); } catch { /* already released */ }
    try { link.writer.releaseLock(); } catch { /* already released */ }
    try { await link.port.close(); } catch { /* already closed */ }
  }

  private set(status: PlantSerialStatus) {
    this.status = status;
    this.listeners.forEach((fn) => fn());
  }
}

function loadPrefs(): PlantPrefs {
  const prefs = { sound: true, arms: true };
  try {
    return { ...prefs, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") };
  } catch {
    return prefs;
  }
}

const serial = typeof navigator === "undefined" ? undefined : (navigator as Navigator & { serial?: SerialLike }).serial;
export const plantSerial = new PlantSerial(serial, plantBridge);
