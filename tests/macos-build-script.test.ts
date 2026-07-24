import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The macOS build script deletes whatever sits at its destination, so its containment
// check is a safety boundary rather than a convenience. These run the real script.
//
// Each case previously shipped as a defect:
//   - the original check compared two values derived from the same variable, so any
//     OUTPUT_DIR passed;
//   - resolving logical paths let a repo-local symlink point outside;
//   - re-appending an unresolved tail let `.ocx-nope/../../outside` escape entirely.

const repoRoot = resolve(import.meta.dir, "..");
const script = join(repoRoot, "scripts", "build-macos-app.sh");
const isMacOS = process.platform === "darwin";

async function runScript(outputDir: string) {
  const proc = Bun.spawn(["bash", script], {
    cwd: repoRoot,
    env: { ...process.env, OUTPUT_DIR: outputDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stderr, exitCode };
}

describe.skipIf(!isMacOS)("macOS build script containment", () => {
  test("refuses a destination outside the repository and creates nothing", async () => {
    const outside = join(tmpdir(), "..", "..", "ocx-containment-probe");
    const target = resolve(outside);
    rmSync(target, { recursive: true, force: true });

    const { stderr, exitCode } = await runScript(target);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Refusing to build into");
    expect(existsSync(target)).toBe(false);
  }, 120_000);

  // The bypass: neither component exists, so the resolver walked up to the repository
  // and re-appended the tail verbatim. `..` then escaped during mkdir -p.
  test("refuses an unresolved .. traversal before creating any directory", async () => {
    // Built by string concatenation, NOT path.join: join() normalises `..` itself, so
    // the script would never receive the traversal that was the actual bypass.
    const traversal = `${repoRoot}/.ocx-traversal-probe/../../ocx-escaped-probe`;
    const escaped = resolve(repoRoot, "..", "ocx-escaped-probe");
    const intermediate = join(repoRoot, ".ocx-traversal-probe");
    rmSync(escaped, { recursive: true, force: true });
    rmSync(intermediate, { recursive: true, force: true });

    const { stderr, exitCode } = await runScript(traversal);

    expect(exitCode).not.toBe(0);
    // The message must name the RESOLVED path, proving normalization happened.
    expect(stderr).toContain("ocx-escaped-probe");
    expect(stderr).toContain("Refusing to build into");
    expect(existsSync(escaped)).toBe(false);
    expect(existsSync(intermediate)).toBe(false);
  }, 120_000);

  test("allows a destination inside the repository", async () => {
    const inside = join(repoRoot, "dist", "macos-containment-check");
    rmSync(inside, { recursive: true, force: true });

    const { stderr, exitCode } = await runScript(inside);
    rmSync(inside, { recursive: true, force: true });

    // Building may fail for toolchain reasons; what matters is that it was not refused.
    expect(stderr).not.toContain("Refusing to build into");
    if (exitCode === 0) expect(stderr).not.toContain("Refusing");
  }, 300_000);

  test("allows a temp destination", async () => {
    const temp = mkdtempSync(join(tmpdir(), "ocx-containment-"));
    const { stderr } = await runScript(temp);
    rmSync(temp, { recursive: true, force: true });

    expect(stderr).not.toContain("Refusing to build into");
  }, 300_000);
});
