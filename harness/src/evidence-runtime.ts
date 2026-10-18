import type { FileSnapshot, ToolRuntime } from "./types.js";

/** Per-run snapshot cache, never shared between users or revisions. The authority
 * still revalidates observations before writing. Complete files only: no silent truncation. */
export function boundedEvidenceRuntime(runtime: ToolRuntime, limit: number): ToolRuntime {
  if (!Number.isInteger(limit) || limit < 1024 || limit > 96_000) throw new Error("Invalid evidence limit");
  const contents = new Map<string, string>();
  let inspected = 0;
  const readText = async (path: string) => {
    if (contents.has(path)) return contents.get(path)!;
    const content = await runtime.readText(path);
    inspected += content.length;
    if (inspected > 16_000_000) throw new Error("Repository exceeds local evidence budget");
    contents.set(path, content);
    return content;
  };
  return {
    outputLimit: limit, events: runtime.events,
    listFiles: () => runtime.listFiles(), searchCode: query => runtime.searchCode(query), readText,
    readFiles: async paths => {
      const result: FileSnapshot[] = [];
      let length = 0;
      for (const path of [...new Set(paths)]) {
        const content = await readText(path);
        length += content.length + path.length + 8;
        if (length > limit) throw new Error("Complete evidence exceeds input budget");
        result.push({ path, content });
      }
      return result;
    },
    writeFiles: async files => {
      const written = await runtime.writeFiles(files);
      for (const file of files) contents.delete(file.path);
      return written;
    },
    runTests: path => runtime.runTests(path),
  };
}
