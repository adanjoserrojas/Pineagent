/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  // Pre-bundle the heavy dependencies at startup. Otherwise Vite discovers Monaco on the first file
  // open, re-optimizes, and can reload the page mid-session.
  optimizeDeps: { include: ["monaco-editor", "@monaco-editor/react", "socket.io-client", "@auth0/auth0-react"] },
  test: { include: ["tests/unit/**/*.test.ts"] },
});
