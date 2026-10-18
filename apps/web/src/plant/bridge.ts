import { DEV_TOOLS } from "../devtools";
import type { FaceKey } from "../runs/runs";

// Where the plant's face goes. The on-screen VirtualPlant is one sink; the Hardware Engineer's
// Web Serial bridge is the other: it attaches here and turns each face into `STATE <face>\n`.
export interface PlantSink {
  show(face: FaceKey): void;
}

export class PlantBridge {
  private face: FaceKey = "idle";
  private readonly sinks = new Set<PlantSink>();

  // A sink gets the current face right away, which is also the re-send after a replug (LLD 9).
  attach(sink: PlantSink): () => void {
    this.sinks.add(sink);
    sink.show(this.face);
    return () => this.sinks.delete(sink);
  }

  update(face: FaceKey) {
    if (face === this.face) return;
    this.face = face;
    this.sinks.forEach((s) => s.show(face));
  }

  current(): FaceKey {
    return this.face;
  }
}

export const plantBridge = new PlantBridge();

// Lets the Hardware Engineer try a bridge from the console, and lets e2e read the face.
if (DEV_TOOLS && typeof window !== "undefined") (window as unknown as { __plant?: PlantBridge }).__plant = plantBridge;
