// Copies the plant's face set from the Hardware Engineer's firmware assets into the web app.
// The firmware folder stays the source of truth; rerun this after the faces change:
//   npm run sync-faces
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../../../firmware/PlantBotTestKit/animations/viewport/states.json", import.meta.url));
const target = fileURLToPath(new URL("../src/plant/faces.json", import.meta.url));

const states = JSON.parse(await readFile(source, "utf8"));
const faces = states.map(({ key, title, background, color, kind, motion, behavior, svg }) => {
  if (typeof svg !== "string" || !svg.startsWith("<svg")) throw new Error(`state ${key} has no SVG`);
  return { key, title, background: `#${background}`, color: `#${color}`, kind, motion, behavior, svg };
});
await writeFile(target, JSON.stringify(faces, null, 1) + "\n");
const loops = new URL("../public/faces/", import.meta.url);
await mkdir(loops, { recursive: true });
for (const { key } of faces) {
  if (!/^[a-z_]+$/.test(key)) throw new Error("Invalid face key");
  await copyFile(new URL(`../../../firmware/PlantBotTestKit/animations/viewport/${key}-loop.gif`, import.meta.url), new URL(`${key}-loop.gif`, loops));
}
console.log(`wrote ${faces.length} faces to src/plant/faces.json`);
