import { readdir } from "node:fs/promises";
import path from "node:path";

export async function worldPackDirectories(root) {
  const worlds = path.join(root, "worlds");
  const entries = await readdir(worlds, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name === "manifest.json")
    .map((entry) => path.relative(worlds, entry.parentPath).split(path.sep).join("/"))
    .sort();
}
