import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { WorkspaceSocket } from "../net/socket";
import "@xterm/xterm/css/xterm.css";

// Server/repository strings are text, never executable terminal escape sequences.
const safe = (text: string) => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").replace(/\n/g, "\r\n");

export function WorkspaceTerminal({ socket, onClose }: { socket: WorkspaceSocket; onClose(): void }) {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!element.current) return;
    const colors = getComputedStyle(element.current);
    const terminal = new Terminal({ convertEol: true, cursorBlink: false, screenReaderMode: true, scrollback: 500,
      fontSize: 12, fontFamily: colors.getPropertyValue("--mono"),
      theme: { background: colors.getPropertyValue("--ground").trim(), foreground: colors.getPropertyValue("--text").trim() } });
    const fit = new FitAddon();
    terminal.loadAddon(fit); terminal.open(element.current);
    const resize = new ResizeObserver(() => { if (element.current?.clientWidth) fit.fit(); });
    resize.observe(element.current); fit.fit();
    terminal.writeln("Pineagent Rust CLI · isolated command mode (not a system shell)");
    terminal.writeln("run TASK | runs | read PATH | lock/unlock PATH | pause/resume ID");
    terminal.writeln("approve ID CANDIDATE | reject ID HINT | git-status");
    let line = "", busy = false, disposed = false;
    const prompt = () => terminal.write("\r\n> ");
    prompt();
    const input = terminal.onData(data => {
      if (busy || !socket.connected) return;
      // Ignore cursor/control escape sequences; paste cannot execute multiple commands.
      if (data.includes("\x1b")) return;
      if (data === "\r") {
        if (!line.trim()) return;
        const command = line; line = ""; busy = true; terminal.write("\r\n");
        socket.timeout(160_000).emit("terminal:command", { line: command }, (error, response) => {
          if (disposed) return;
          busy = false;
          terminal.write(safe(error ? "Command outcome unknown. Reconnect and inspect before retrying."
            : response.ok ? JSON.stringify(response.result, null, 2).slice(0, 32_000)
            : response.code === "NOT_AVAILABLE" ? "Terminal not enabled on this server."
            : "Command refused. Check command syntax, connection, and workspace permissions."));
          prompt();
        });
      } else if (data === "\x7f") {
        if (line) { line = [...line].slice(0, -1).join(""); terminal.write("\b \b"); }
      } else if (data === "\x03") { line = ""; terminal.write("^C"); prompt(); }
      else {
        const text = data.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
        if (new TextEncoder().encode(line + text).length <= 8000) { line += text; terminal.write(text); }
      }
    });
    const disconnected = () => { if (!disposed) terminal.writeln("\r\nDisconnected. No commands are replayed."); };
    socket.on("disconnect", disconnected);
    terminal.focus();
    return () => { disposed = true; socket.off("disconnect", disconnected); input.dispose(); resize.disconnect(); terminal.dispose(); };
  }, [socket]);
  return <section className="workspace-terminal" aria-label="Workspace terminal">
    <div className="panel-controls"><span>TERMINAL · RUST CLI</span><button type="button" onClick={onClose} aria-label="Close terminal">×</button></div>
    <div ref={element} className="terminal-surface" />
  </section>;
}
