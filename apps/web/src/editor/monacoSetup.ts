import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/editor/editor.worker?worker";
import cssWorker from "monaco-editor/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/language/json/json.worker?worker";
import tsWorker from "monaco-editor/language/typescript/ts.worker?worker";

// Bundle Monaco instead of letting @monaco-editor/react fetch it from a CDN at runtime.
self.MonacoEnvironment = {
  getWorker(_id, label) {
    if (label === "typescript" || label === "javascript") return new tsWorker();
    if (label === "json") return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new cssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker();
    return new editorWorker();
  },
};
loader.config({ monaco });

// Only the open file is a model, so cross-file imports would all show as errors. Keep syntax
// checks, drop semantic ones until the editor knows about the whole repo.
monaco.typescript.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true });
monaco.typescript.javascriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true });

// Colors from the design canvas tokens.
monaco.editor.defineTheme("pineagent", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "keyword", foreground: "8FC8FF" },
    { token: "string", foreground: "E8C486" },
    { token: "comment", foreground: "7F9187", fontStyle: "italic" },
    { token: "number", foreground: "F5B97A" },
    { token: "type", foreground: "8CE6BA" },
    { token: "type.identifier", foreground: "8CE6BA" },
  ],
  colors: {
    "editor.background": "#0E1411",
    "editor.foreground": "#E6EDE8",
    "editor.lineHighlightBackground": "#121A16",
    "editor.lineHighlightBorder": "#121A16",
    "editorLineNumber.foreground": "#56685E",
    "editorLineNumber.activeForeground": "#9AABA1",
    "editor.selectionBackground": "#1E3550",
    "editorCursor.foreground": "#8FC8FF",
    "editorIndentGuide.background1": "#1A2A22",
    "editorWidget.background": "#121A16",
    "editorWidget.border": "#26332C",
    "scrollbarSlider.background": "#26332C80",
  },
});
