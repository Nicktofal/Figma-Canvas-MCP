import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");

export interface Skill {
  name: string;
  title: string;
  body: string;
}

export function loadSkills(): Skill[] {
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }
  return files.map((f) => {
    const body = readFileSync(join(dir, f), "utf8");
    const title = /^#\s+(.+)$/m.exec(body)?.[1] ?? f;
    return { name: f.replace(/\.md$/, ""), title, body };
  });
}
