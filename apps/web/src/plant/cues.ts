import type { FaceKey } from "../runs/runs";

// What the robot does, besides its face, when the plant changes to a face. Commands are the test
// firmware's (PlantBotTest.ino). The speaker (TONE, MELODY) and the arms (SERVO) only run on the
// external 5 V supply; the firmware refuses them otherwise, and the piezo stands in for the speaker.
export type CueStep = {
  cmd: string;
  kind: "sound" | "arms";
  ms: number; // how long the firmware is busy with it; it answers only when it's done
  power?: boolean; // needs the 5 V supply
  piezo?: string; // what to play instead when there is no 5 V supply
};

export const CUES: Partial<Record<FaceKey, CueStep[]>> = {
  done: [
    { cmd: "MELODY 30", kind: "sound", ms: 700, power: true, piezo: "PIEZO CHIRP" },
    { cmd: "SERVO WAVE", kind: "arms", ms: 1600, power: true },
  ],
  awaiting_approval: [{ cmd: "PIEZO CHIRP", kind: "sound", ms: 600 }],
  error: [
    { cmd: "TONE 330 180 25", kind: "sound", ms: 200, power: true, piezo: "PIEZO 700 180" },
    { cmd: "TONE 220 420 25", kind: "sound", ms: 440, power: true, piezo: "PIEZO 500 420" },
  ],
  team_join: [
    { cmd: "PIEZO 2600 70", kind: "sound", ms: 80 },
    { cmd: "PIEZO 3500 110", kind: "sound", ms: 120 },
  ],
  team_leave: [
    { cmd: "PIEZO 3500 70", kind: "sound", ms: 80 },
    { cmd: "PIEZO 2600 110", kind: "sound", ms: 120 },
  ],
};
