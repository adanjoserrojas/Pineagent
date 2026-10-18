import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { Member } from "../contracts/socket";
import type { SessionManager } from "./sessions";
import { ResizeHandle } from "../ui/ResizeHandle";

const EditorPane = lazy(() => import("./EditorPane"));
export type SplitDirection = "right" | "down" | null;

export function EditorGroups({ paths, active, split, manager, connected, selfId, members, onActivate, onCloseSplit, onPauseRun, welcome }: {
  paths: [string | null, string | null]; active: 0 | 1; split: SplitDirection; manager: SessionManager | null;
  connected: boolean; selfId: string | null; members: Member[];
  onActivate: (group: 0 | 1) => void; onCloseSplit: () => void; onPauseRun: (runId: string) => void; welcome: ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [ratio, setRatio] = useState(0.5);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    if (host.current) observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  const stacked = split === "down" || size.width < 560;
  const extent = Math.max(1, (stacked ? size.height : size.width) - 6);
  return <div ref={host} className="editor-groups" data-split={split ? (stacked ? "down" : "right") : "none"}
    style={{ "--split-first": `${ratio}fr`, "--split-second": `${1 - ratio}fr` } as CSSProperties}>
    {([0, 1] as const).filter((index) => index === 0 || split).map((index) => (
      <div key={index} className="editor-group-slot">
        {index === 1 && <ResizeHandle label="Resize editor split" axis={stacked ? "y" : "x"} value={ratio * extent}
          min={extent * 0.25} max={extent * 0.75} onChange={(value) => setRatio(value / extent)} onReset={() => setRatio(0.5)} />}
        <section className="editor-group" aria-label={`Editor group ${index + 1}`} data-active={active === index}
          onPointerDownCapture={() => onActivate(index)} onFocusCapture={() => onActivate(index)}>
          {split && <div className="group-toolbar">
            <button type="button" aria-label={`Focus editor group ${index + 1}`} onClick={(event) => {
              onActivate(index); event.currentTarget.closest(".editor-group")?.querySelector<HTMLTextAreaElement>(".monaco-editor textarea")?.focus();
            }}>GROUP {index + 1}</button>
            <span>{active === index ? "Files open here" : ""}</span>
            {index === 1 && <button type="button" aria-label="Close split" title="Close second editor group" onClick={onCloseSplit}>×</button>}
          </div>}
          {paths[index] && manager ? <Suspense fallback={<p className="editor-note">Starting editor…</p>}>
            <EditorPane paneId={`group-${index}`} manager={manager} path={paths[index]} connected={connected}
              selfId={selfId} members={members} onPauseRun={onPauseRun} />
          </Suspense> : welcome}
        </section>
      </div>
    ))}
  </div>;
}
