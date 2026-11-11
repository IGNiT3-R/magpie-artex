// Inspect only explicitly publishable Git blobs or an actual npm archive.
// Findings contain filenames/rule names, never the matching credential text.
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const root = fileURLToPath(new URL("..", import.meta.url));
const publicRoots = new Set([".github", ".githooks", "bin", "compat", "lib", "page", "scripts", "test", "test-support"]);
const publicFiles = new Set([".gitattributes", ".gitignore", "package.json", "README.md", "CONTRIBUTING.md", "CHANGELOG.md", "SECURITY.md", "LICENSE", "artex.agent.js", "index.mjs"]);
const excludedDirectory = /^(?:\.git|\.config|\.playwright-cli|node_modules|output|coverage|instances|backups?|logs?)$/i;
const excludedFile = /^(?:\.env(?:\..*)?|(?:config|agent|agents|state|status|legacy-upgrade|official-agent)\.json|sync\.lock.*|id_(?:rsa|ed25519)|.*-key)$/i;
const excludedExtension = /\.(?:tgz|zip|7z|tar|gz|exe|dll|db(?:-.*)?|sqlite.*|log|tmp|pending|bak|backup|key|pem|p12|pfx)$/i;
const rules = [
  ["private-key", /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ["service-token", /\b(?:sk-(?:(?:proj|ant)-)?[A-Za-z0-9_-]{24,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[A-Z0-9]{16})\b/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/],
  ["url-credentials", /https?:\/\/[^\s/"'`]+:[^\s/"'`]+@/],
  ["windows-path", /\b[A-Za-z]:[\\/]/],
  ["home-path", /\/(?:Users|home)\/[A-Za-z0-9_.-]+\//],
  ["root-home-path", /\/root\/(?:\.cache|\.config|\.local|\.codex)\//],
  ["email-address", /\b[A-Za-z0-9._%+-]+@(?![A-Za-z0-9.-]*users\.noreply\.github\.com\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/],
];

export function inspectEntry(name, bytes, mode = "100644") {
  const findings = [];
  const parts = name.split("/");
  if (name.includes("\\") || parts.some((part) => !part || part === "." || part === "..") ||
      (!publicFiles.has(name) && !(parts.length > 1 && publicRoots.has(parts[0])))) findings.push({ rule: "public-file-boundary" });
  if (parts.slice(0, -1).some((part) => excludedDirectory.test(part)) || excludedFile.test(parts.at(-1)) || excludedExtension.test(name)) findings.push({ rule: "local-runtime-file" });
  if (!["100644", "100755"].includes(mode)) findings.push({ rule: "non-regular-file" });
  if (bytes.length > 2 * 1024 * 1024 || bytes.includes(0)) return [...findings, { rule: "binary-or-oversized-file" }];
  const content = bytes.toString("utf8");
  for (const [rule, pattern] of rules) {
    const match = pattern.exec(content);
    if (match) findings.push({ rule, line: content.slice(0, match.index).split("\n").length });
  }
  return findings;
}

export function unpackPackage(archive) {
  const tar = gunzipSync(archive), entries = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
    const prefix = field(345, 155), base = field(0, 100);
    const name = prefix ? `${prefix}/${base}` : base;
    const sizeText = field(124, 12).trim();
    if (!/^[0-7]+$/.test(sizeText)) throw new Error("Invalid archive entry size");
    const size = parseInt(sizeText, 8), type = header[156];
    if (![0, 48].includes(type) || !name.startsWith("package/") || offset + 512 + size > tar.length) throw new Error("Unexpected npm archive entry");
    const mode = parseInt(field(100, 8).trim(), 8) & 0o111 ? "100755" : "100644";
    entries.push({ name: name.slice(8), bytes: tar.subarray(offset + 512, offset + 512 + size), mode });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!entries.length || new Set(entries.map((entry) => entry.name)).size !== entries.length) throw new Error("Empty or duplicate npm archive entries");
  return entries;
}

function git(...args) {
  return execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024, windowsHide: true });
}

async function stagedEntries() {
  const records = git("ls-files", "--stage", "-z").toString("utf8").split("\0").filter(Boolean);
  if (!records.length) throw new Error("No staged/tracked files; stage the public source files first");
  return records.map((record) => {
    const match = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(record);
    if (!match || match[3] !== "0") throw new Error("Resolve Git index conflicts before publication");
    return { name: match[4], mode: match[1], bytes: git("cat-file", "blob", match[2]) };
  });
}

async function packageEntries() {
  const npmCLI = process.env.npm_execpath;
  if (!npmCLI) throw new Error("Run the package check through npm run check:package");
  const directory = await mkdtemp(path.join(tmpdir(), "magpie-artex-public-"));
  try {
    const output = execFileSync(process.execPath, [npmCLI, "pack", "--ignore-scripts", "--json", "--pack-destination", directory], {
      cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    });
    const [meta] = JSON.parse(output.toString("utf8"));
    if (!meta?.filename || path.basename(meta.filename) !== meta.filename) throw new Error("Invalid npm package filename");
    const entries = unpackPackage(await readFile(path.join(directory, meta.filename)));
    const expected = meta.files.map((entry) => entry.path).sort();
    if (JSON.stringify(entries.map((entry) => entry.name).sort()) !== JSON.stringify(expected)) throw new Error("npm file manifest and archive differ");
    return entries;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--package") || args.length > 1) throw new Error("Usage: check-public.mjs [--package]");
  const entries = args.length ? await packageEntries() : await stagedEntries();
  let count = 0;
  for (const entry of entries) {
    for (const finding of inspectEntry(entry.name, entry.bytes, entry.mode)) {
      console.error(`${JSON.stringify(entry.name)}${finding.line ? `:${finding.line}` : ""}: ${finding.rule}`);
      count++;
    }
  }
  if (count) throw new Error(`${count} publication findings; remove private data before committing or packing`);
  console.log(`Public ${args.length ? "npm archive" : "Git index"}: ${entries.length} files checked; no publication findings.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // A child-process exception may contain stdout/stderr. Never print it.
    console.error(error.status === undefined ? error.message : "Publication check could not read Git/npm input");
    process.exitCode = 1;
  });
}
