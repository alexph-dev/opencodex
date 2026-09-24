import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { claimOwnedServiceHome } from "../helpers/owned-service-home";

test("sync-cache succeeds without rewriting an already current cache and fails on malformed catalog", () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-noop-regression-"));
  const home = join(root, "home"), codex = join(root, "codex"), ocx = join(root, "ocx");
  for (const path of [home, codex, ocx]) mkdirSync(path, { mode: 0o700 });
  const owned = claimOwnedServiceHome(codex, ocx, home);
  const env = { ...process.env, ...owned.env, HOME: home, USERPROFILE: home, CODEX_HOME: codex, OPENCODEX_HOME: ocx };
  writeFileSync(join(codex, "config.toml"), 'model_catalog_json = "catalog.json"\n');
  const catalog = join(codex, "catalog.json"), cache = join(codex, "models_cache.json");
  writeFileSync(catalog, JSON.stringify({ models: [{ slug: "vendor/model", context_window: 245760 }] }));
  function run(...args: string[]) {
    const result = Bun.spawnSync([process.execPath, "run", "src/cli/index.ts", "sync-cache", "--json", ...args], {
      cwd: join(import.meta.dir, "..", ".."), env, stdout: "pipe", stderr: "pipe",
    });
    return { code: result.exitCode, body: JSON.parse(result.stdout.toString()), stderr: result.stderr.toString() };
  }
  const first = run();
  expect(first.code).toBe(0);
  expect(first.body.wrote).toBe(true);
  const bytes = readFileSync(cache, "utf8"), mtime = statSync(cache).mtimeMs;
  const second = run();
  expect(second.code).toBe(0);
  expect(second.body).toMatchObject({ ok: true, wrote: false, skipped: true, skippedReason: "unchanged" });
  expect(readFileSync(cache, "utf8")).toBe(bytes);
  expect(statSync(cache).mtimeMs).toBe(mtime);
  const legacy = Bun.spawnSync([process.execPath, "--eval", 'import { invalidateCodexModelsCache } from "./src/codex/catalog/sync.ts"; console.log(invalidateCodexModelsCache({allowWhenDesiredDisabled:true}));'], {
    cwd: join(import.meta.dir, "..", ".."), env, stdout: "pipe", stderr: "pipe",
  });
  expect(legacy.exitCode).toBe(0);
  expect(legacy.stdout.toString().trim()).toBe("false");
  writeFileSync(catalog, "{broken");
  const broken = run();
  expect(broken.code).toBe(1);
  expect(broken.body.ok).toBe(false);
  expect(readFileSync(cache, "utf8")).toBe(bytes);
  renameSync(catalog, join(codex, "broken-catalog.json"));
  const absent = run();
  expect(absent.code).toBe(0);
  expect(absent.body.skippedReason).toBe("no_catalog");
  writeFileSync(catalog, JSON.stringify({ models: [{ slug: "vendor/changed" }] }));
  renameSync(cache, join(codex, "old-cache.json"));
  mkdirSync(cache);
  const unwritable = run();
  expect(unwritable.code).toBe(1);
  expect(unwritable.body.ok).toBe(false);
}, 30000);
