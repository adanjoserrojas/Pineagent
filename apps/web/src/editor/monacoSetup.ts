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
    "editor.background": "#101713",
    "editor.foreground": "#E5EBE4",
    "editor.lineHighlightBackground": "#151E19",
    "editor.lineHighlightBorder": "#151E19",
    "editorLineNumber.foreground": "#829187",
    "editorLineNumber.activeForeground": "#94A396",
    "editor.selectionBackground": "#24384A",
    "editorCursor.foreground": "#ACCAF1",
    "editorIndentGuide.background1": "#1D2921",
    "editorWidget.background": "#151E19",
    "editorWidget.border": "#2A372E",
    "scrollbarSlider.background": "#2A372E80",
  },
});
