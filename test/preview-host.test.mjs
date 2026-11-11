import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { pathsFor, readJSON, writeJSON } from "../lib/files.mjs";
import { artexServer, selection, temporaryPaths } from "../test-support/artex.mjs";

test("Magpie's disconnect-preview host never starts synchronization or sends ARTEX requests", async (t) => {
  const home = await temporaryPaths(t), api = await artexServer(t);
  const paths = pathsFor(path.join(home.dir, ".config", "magpie-artex"));
  await writeJSON(paths.config, { version: 1, url: api.url, password: api.password });
  await writeJSON(paths.agent, selection());
  const code = "const {default: plugin}=await import(process.argv[1]); await plugin({directory:process.env.ARTEX_FIXTURE_MAGPIE},{port:Number(process.env.ARTEX_FIXTURE_PORT)});";
  await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", code, new URL("../index.mjs", import.meta.url).href], {
    windowsHide: true, timeout: 5000,
    env: { ...process.env, HOME: home.dir, USERPROFILE: home.dir,
      MAGPIE_DRY_PROVIDERS: path.join(home.dir, ".magpie-dry-providers"),
      ARTEX_FIXTURE_MAGPIE: path.join(home.dir, ".config", "magpie"),
      ARTEX_FIXTURE_PORT: new URL(api.url).port },
  });
  assert.equal(api.requests.length, 0);
  assert.equal(api.writes.length, 0);
  assert.equal(await readJSON(paths.state), null);
  assert.equal(await readJSON(paths.status), null);
});
