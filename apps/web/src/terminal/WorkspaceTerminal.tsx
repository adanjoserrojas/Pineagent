import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { WorkspaceSocket } from "../net/socket";
import "@xterm/xterm/css/xterm.css";

export function WorkspaceTerminal({ socket, onClose }: { socket: WorkspaceSocket; onClose(): void }) {
  const element = useRef<HTMLDivElement>(null);
  const [attempt, retry] = useState(0);
  const [status, setStatus] = useState("Connecting…");
  useEffect(() => {
    if (!element.current) return;
    const colors = getComputedStyle(element.current);
    const terminal = new Terminal({ cursorBlink: false, screenReaderMode: true, scrollback: 500,
      fontSize: 12, fontFamily: colors.getPropertyValue("--mono"),
      theme: { background: colors.getPropertyValue("--ground").trim(), foreground: colors.getPropertyValue("--text").trim() } });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(element.current);
    // Preserve Ratatui screen controls, but never permit clipboard writes.
    const clipboard = terminal.parser.registerOscHandler(52, () => true);
    let id: string | null = null, disposed = false, inputPending = "", sending = false;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (message: string) => {
      const previous = id; id = null; inputPending = "";
      if (previous && socket.connected) socket.emit("terminal:close", { id: previous }, () => {});
      if (!disposed) setStatus(message);
    };
    const flush = async () => {
      if (sending || !id || !inputPending || !socket.connected) return;
      sending = true;
      try {
        while (id && inputPending && !disposed) {
          const data = inputPending; inputPending = "";
          const result = await socket.timeout(5000).emitWithAck("terminal:input", { id, data });
          if (!result.ok) throw new Error("Input refused");
        }
      } catch { stop("Input outcome unknown. Reopen to inspect; input is never replayed."); }
      finally { sending = false; }
    };
    const input = terminal.onData(data => {
      if (!id || !socket.connected) return;
      if (new TextEncoder().encode(inputPending + data).length > 8192) return stop("Input limit exceeded. Reopen terminal.");
      inputPending += data; void flush();
    });
    const output = (message: { id: string; data: string }, ack: () => void) => {
      if (disposed || message.id !== id) { ack(); return; }
      try { terminal.write(Uint8Array.from(atob(message.data), c => c.charCodeAt(0)), ack); }
      catch { ack(); stop("Invalid terminal output."); }
    };
    const exited = (message: { id: string }) => { if (message.id === id) stop("Terminal ended. Reopen to reconnect."); };
    const disconnected = () => stop("Disconnected. Reopen after reconnecting; agent runs continue.");
    socket.on("terminal:output", output); socket.on("terminal:exit", exited); socket.on("disconnect", disconnected);
    const resize = new ResizeObserver(() => {
      if (!element.current?.clientWidth) return;
      fit.fit(); clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (id && socket.connected) socket.timeout(5000).emit("terminal:resize", { id, cols: terminal.cols, rows: terminal.rows }, () => {});
      }, 150);
    });
    resize.observe(element.current); fit.fit(); terminal.focus(); setStatus("Connecting…");
    if (socket.connected) socket.timeout(150_000).emit("terminal:open", { cols: terminal.cols, rows: terminal.rows }, (error, result) => {
      if (!error && result.ok) {
        if (disposed) socket.emit("terminal:close", { id: result.id }, () => {});
        else { id = result.id; setStatus("Interactive Ratatui"); }
      } else if (!disposed) setStatus(error ? "Terminal connection timed out. Reopen to retry." : !result.ok && result.code === "NOT_AVAILABLE" ? "Terminal not enabled on this server." : "Terminal refused. Check workspace permissions.");
    });
    else setStatus("Disconnected. Reopen after reconnecting.");
    return () => {
      disposed = true; stop(""); clearTimeout(resizeTimer);
      socket.off("terminal:output", output); socket.off("terminal:exit", exited); socket.off("disconnect", disconnected);
      input.dispose(); clipboard.dispose(); resize.disconnect(); terminal.dispose();
    };
  }, [socket, attempt]);
  return <section className="workspace-terminal" aria-label="Workspace terminal">
    <div className="panel-controls"><span>TERMINAL · RATATUI</span><span role="status">{status}</span>
      <button type="button" onClick={() => retry(value => value + 1)}>Reopen</button>
      <button type="button" onClick={onClose} aria-label="Close terminal">×</button></div>
    <div ref={element} className="terminal-surface" />
  </section>;
}
