import { useEffect, useState } from "react";
import type { ImageAck } from "../contracts/socket";
import type { WorkspaceSocket } from "../net/socket";

const ACK_TIMEOUT_MS = 8000;
type Loaded = { src: string; bytes: number };
type Load = { status: "loading" } | { status: "error"; message: string } | ({ status: "ready" } & Loaded);

const MESSAGES = {
  NOT_FOUND: "isn’t on the server anymore",
  UNSUPPORTED: "isn’t an image the viewer supports",
  TOO_LARGE: "is larger than 2 MB",
} as const;

const formatBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

// Read-only picture viewer. The image is only ever shown through <img src="data:…">, which is
// what keeps a hostile SVG from running scripts; nothing from the file is put into the DOM.
// It is fetched on every open, so reopening shows what Git or a teammate changed.
export default function ImageViewer({ socket, path }: { socket: WorkspaceSocket; path: string }) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [fit, setFit] = useState(true);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setLoad({ status: "loading" });
    setSize(null);
    socket
      .timeout(ACK_TIMEOUT_MS)
      .emitWithAck("file:image", { path })
      .then(
        (res: ImageAck) => {
          if (!live) return;
          setLoad(
            res.ok
              ? { status: "ready", src: `data:${res.mime};base64,${res.data}`, bytes: res.bytes }
              : { status: "error", message: `${path} ${MESSAGES[res.code]}.` },
          );
        },
        () => live && setLoad({ status: "error", message: `The server didn’t send ${path} in time.` }),
      );
    return () => {
      live = false;
    };
  }, [socket, path, attempt]);

  if (load.status === "loading") {
    return (
      <p className="editor-note" role="status">
        Loading {path}…
      </p>
    );
  }
  if (load.status === "error") {
    return (
      <div className="editor-note" role="status">
        <p>{load.message}</p>
        <button type="button" className="btn-secondary" onClick={() => setAttempt((n) => n + 1)}>
          Retry
        </button>
      </div>
    );
  }
  return (
    <section className="image-viewer" aria-label={`Image: ${path}`}>
      <div className={`image-stage ${fit ? "image-fit" : "image-actual"}`}>
        <img
          src={load.src}
          alt={path}
          onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
        />
      </div>
      <footer className="editor-status">
        <span data-testid="image-info" className="mono">
          {size && size.w > 0 ? `${size.w} × ${size.h} · ` : ""}
          {formatBytes(load.bytes)}
        </span>
        <span className="spacer" />
        <button type="button" className="link-btn" aria-pressed={!fit} onClick={() => setFit((f) => !f)}>
          {fit ? "100%" : "Fit"}
        </button>
      </footer>
    </section>
  );
}
