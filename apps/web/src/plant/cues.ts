import type { FaceKey } from "../runs/runs";

// What the robot does, besides its face, when the plant changes to a face. Commands are the test
// firmware's (PlantBotTest.ino). The speaker (TONE, SAY) and the arms (SERVO) only run on the external
// 5 V supply; the firmware refuses them otherwise, and the piezo stands in for the tones.
export type CueStep = {
  kind: "sound" | "arms";
  cmd?: string;
  say?: true; // the face's line from voice.json, through the robot's speaker (or the laptop's)
  ms?: number; // how long the firmware is busy with cmd; it answers only when it's done
  power?: boolean; // needs the 5 V supply
  piezo?: string; // what to play instead when there is no 5 V supply
  waitMs?: number; // only if the plant is still on this face by then (skips faces that flash by)
};

const SAY: CueStep = { kind: "sound", say: true, power: true };
const PASSING: CueStep = { ...SAY, waitMs: 300 };

export const CUES: Partial<Record<FaceKey, CueStep[]>> = {
  planning: [PASSING],
  routing: [PASSING],
  routing_cache: [PASSING],
  routing_llm: [PASSING],
  executing: [PASSING],
  done: [SAY, { cmd: "SERVO WAVE", kind: "arms", ms: 1600, power: true }],
  awaiting_approval: [{ cmd: "PIEZO CHIRP", kind: "sound", ms: 600 }, SAY],
  blocked: [SAY],
  paused: [SAY],
  error: [
    { cmd: "TONE 330 180 25", kind: "sound", ms: 200, power: true, piezo: "PIEZO 700 180" },
    { cmd: "TONE 220 420 25", kind: "sound", ms: 440, power: true, piezo: "PIEZO 500 420" },
    SAY,
  ],
  disconnected: [SAY],
  reconnecting: [SAY],
  team_join: [
    { cmd: "PIEZO 2600 70", kind: "sound", ms: 80 },
    { cmd: "PIEZO 3500 110", kind: "sound", ms: 120 },
    SAY,
  ],
  team_leave: [
    { cmd: "PIEZO 3500 70", kind: "sound", ms: 80 },
    { cmd: "PIEZO 2600 110", kind: "sound", ms: 120 },
    SAY,
  ],
};
