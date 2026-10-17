import { useMemo } from "react";
import type { FaceKey } from "../runs/runs";
import faces from "./faces.json";

type Face = { key: string; title: string; background: string; color: string; motion: string; svg: string };
const BY_KEY = new Map((faces as Face[]).map((f) => [f.key, f]));

export function faceInfo(key: FaceKey): Face {
  return BY_KEY.get(key) ?? BY_KEY.get("idle")!;
}

// The plant's screen, drawn from the firmware's own face set (synced from states.json), with light
// CSS motion standing in for the Rive loops in all-states-motion.gif.
export function VirtualPlant({ face, caption }: { face: FaceKey; caption: string }) {
  const info = faceInfo(face);
  // An <img> data URI renders the SVG without running anything inside it.
  const src = useMemo(() => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(info.svg)}`, [info.svg]);
  return (
    <figure className="plant" data-face={face}>
      <div className="plant-screen" style={{ background: info.background }}>
        <img className={`plant-face plant-motion-${face}`} src={src} alt={`Plant face: ${info.title}`} width={320} height={170} />
      </div>
      <figcaption className="plant-caption">
        <span className="plant-title">{info.title}</span>
        <span>{caption}</span>
      </figcaption>
    </figure>
  );
}
