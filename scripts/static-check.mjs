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
  const localScripts = [...html.matchAll(/<script\s+[^>]*src=["\']\.\/([^"\']+)["\'][^>]*>/g)]
    .map((match) => match[1]);

  for (const script of localScripts) {
    if (!existsSync(`${rootPath}${script}`)) {
      throw new Error(`${htmlFile}: script not found: ${script}`);
    }
  }
}

function assertDomIds(jsFile, htmlFile) {
  const js = readFileSync(`${rootPath}${jsFile}`, "utf8");
  const html = readFileSync(`${rootPath}${htmlFile}`, "utf8");
  const ids = [...js.matchAll(/document\.getElementById\(["\']([^"\']+)["\']\)/g)]
    .map((match) => match[1]);

  for (const id of new Set(ids)) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`id=["\']${escaped}["\']`);
    if (!pattern.test(html)) {
      throw new Error(`${jsFile}: #${id} not found in ${htmlFile}`);
    }
  }
}

assertDomIds("app.js", "index.html");
assertDomIds("owner.js", "owner.html");

for (const required of [
  "role-ui.js",
  "docs/role-model.md",
  "docs/regression-checklist.md",
  "docs/current-roadmap.md",
  "docs/android-smoke-test.md",
  "docs/meaningful-gap-design.md",
]) {
  if (!existsSync(`${rootPath}${required}`)) {
    throw new Error(`required file not found: ${required}`);
  }
}

console.log(`static check passed: ${jsFiles.length} JavaScript files parsed; DOM ids verified`);
