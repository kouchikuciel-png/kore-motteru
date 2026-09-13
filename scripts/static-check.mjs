import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { execFileSync } from "node:child_process";

const root = new URL("../", import.meta.url);
const rootPath = decodeURIComponent(root.pathname);

const files = readdirSync(rootPath, { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name);

const jsFiles = files.filter((name) => extname(name) === ".js");
for (const file of jsFiles) {
  execFileSync(process.execPath, ["--check", `${rootPath}${file}`], {
    stdio: "inherit",
  });
}

for (const htmlFile of ["index.html", "owner.html"]) {
  const html = readFileSync(`${rootPath}${htmlFile}`, "utf8");
  const localScripts = [...html.matchAll(/<script\s+[^>]*src=["']\.\/([^"']+)["'][^>]*>/g)]
    .map((match) => match[1]);

  for (const script of localScripts) {
    if (!existsSync(`${rootPath}${script}`)) {
      throw new Error(`${htmlFile}: script not found: ${script}`);
    }
  }
}

for (const required of ["role-ui.js", "docs/role-model.md", "docs/regression-checklist.md", "docs/current-roadmap.md"]) {
  if (!existsSync(`${rootPath}${required}`)) {
    throw new Error(`required file not found: ${required}`);
  }
}

console.log(`static check passed: ${jsFiles.length} JavaScript files parsed`);
