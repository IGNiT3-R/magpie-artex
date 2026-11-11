import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { inspectEntry, unpackPackage } from "../scripts/check-public.mjs";

const inspect = (name, content, mode) => inspectEntry(name, Buffer.from(content), mode);

test("publication boundary blocks local artifacts even when force-added to Git", () => {
  for (const name of ["output/proof.json", ".playwright-cli/page.yml", "lib/config.json", "lib/secret.key", "page/database.sqlite", ".env", "lib/backup/settings.json"]) {
    assert.ok(inspect(name, "{}").length > 0, name);
  }
  assert.ok(inspect("lib/link.mjs", "harmless", "120000").some((item) => item.rule === "non-regular-file"));
  assert.ok(inspectEntry("lib/image.mjs", Buffer.from([1, 0, 2])).some((item) => item.rule === "binary-or-oversized-file"));
  assert.deepEqual(inspect("lib/example.mjs", 'export const password = "fixture-password";'), []);
  assert.deepEqual(inspect("README.md", "http://localhost:8787 and https://gateway.example.invalid"), []);
});

test("publication scanner reports credential locations without returning their values", () => {
  const secrets = [
    ["github-token", "gh" + "p_" + "A".repeat(36)],
    ["service-token", "sk-" + "B".repeat(40)],
    ["private-key", "-----BEGIN " + "PRIVATE KEY-----"],
    ["jwt", [Buffer.from('{"alg":"HS256"}').toString("base64url"), "C".repeat(24), "D".repeat(32)].join(".")],
    ["url-credentials", "https://" + ["user", "private-password"].join(":") + "@gateway.example.invalid"],
    ["windows-path", "C:" + "\\Users\\developer\\project"],
    ["home-path", ["", "home", "developer", "project"].join("/")],
    ["email-address", ["developer", "example.com"].join("@")],
  ];
  for (const [rule, secret] of secrets) {
    const result = inspect("README.md", `example\n${secret}\n`);
    assert.ok(result.some((item) => item.rule === rule && item.line === 2), rule);
    assert.ok(!JSON.stringify(result).includes(secret));
  }
});

function archive(name, content, type = "0") {
  const header = Buffer.alloc(512), body = Buffer.from(content);
  header.write(name, 0, 100);
  header.write("0000644\0", 100, 8);
  header.write(body.length.toString(8).padStart(11, "0") + "\0", 124, 12);
  header.write(type, 156, 1);
  return gzipSync(Buffer.concat([header, body, Buffer.alloc((512 - body.length % 512) % 512), Buffer.alloc(1024)]));
}

test("npm audit inspects decompressed file bytes and refuses links and unsafe names", () => {
  const secret = "gh" + "p_" + "A".repeat(36);
  const [entry] = unpackPackage(archive("package/lib/example.mjs", secret));
  assert.ok(inspectEntry(entry.name, entry.bytes, entry.mode).some((item) => item.rule === "github-token"));
  assert.throws(() => unpackPackage(archive("package/lib/link.mjs", "private", "2")), /Unexpected/);
  assert.throws(() => unpackPackage(archive("outside/README.md", "example")), /Unexpected/);
  const [unsafe] = unpackPackage(archive("package/../README.md", "example"));
  assert.ok(inspectEntry(unsafe.name, unsafe.bytes).some((item) => item.rule === "public-file-boundary"));
});
