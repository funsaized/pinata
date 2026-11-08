import { readFile, writeFile } from "node:fs/promises";
import { convertInput } from "./inputs.ts";
export async function migrateFile(file: string, output?: string): Promise<string[]> {
  const raw = await readFile(file, "utf8");
  let encoded: string;
  let notices: string[];
  if (file.endsWith(".md")) {
    const { parseFrontmatter } = await import("@earendil-works/pi-coding-agent");
    const { frontmatter, body } = parseFrontmatter(raw);
    const converted = convertInput({ ...frontmatter, prompt: body.trim() });
    const { prompt, ...metadata } = converted.value;
    encoded = `---\n${Object.entries(metadata)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join("\n")}\n---\n\n${String(prompt)}\n`;
    notices = converted.notices;
  } else {
    const converted = convertInput(JSON.parse(raw));
    encoded = JSON.stringify(converted.value, null, 2) + "\n";
    notices = converted.notices;
  }
  if (output) await writeFile(output, encoded, { flag: "wx", mode: 0o600 });
  else process.stdout.write(encoded);
  return notices;
}
