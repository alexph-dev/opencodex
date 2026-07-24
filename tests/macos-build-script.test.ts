import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The macOS build script deletes whatever sits at its destination, so its containment
// check is a safety boundary rather than a convenience. These run the real script.
//
// Every case here shipped as a defect at some point:
//   - the original check compared two values derived from the same variable, so any
//     OUTPUT_DIR passed;
//   - resolving logical paths let a repository-local symlink point outside;
//   - re-appending an unresolved tail let `.nope/../../outside` escape entirely;
//   - resolving physically BEFORE normalising let `..` reveal a symlink that was then
//     never followed.

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

/// Runs `body` with a uniquely named sandbox that this test owns and always removes.
///
/// An earlier version deleted FIXED paths such as `<repo-parent>/ocx-escaped-probe`,
/// which would have destroyed unrelated data if anything already lived there. A test
/// for a safety boundary must not itself be destructive.
async function withSandbox<T>(body: (sandbox: string) => Promise<T>): Promise<T> {
  const sandbox = mkdtempSync(join(tmpdir(), "ocx-containment-"));
  try {
    return await body(sandbox);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

describe.skipIf(!isMacOS)("macOS build script containment", () => {
  test("refuses a destination outside the repository and creates nothing", async () => {
    // A home-directory path: temp is an explicitly permitted root, so it cannot be used
    // to prove refusal. The name is unique so it cannot collide with anything real.
    const target = join(
      process.env.HOME ?? "/Users/shared",
      `.ocx-outside-${process.pid}-${Date.now()}`,
    );

    const { stderr, exitCode } = await runScript(target);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Refusing to build into");
    expect(existsSync(target)).toBe(false);
  }, 120_000);

  test("refuses an unresolved .. traversal before creating any directory", async () => {
    const intermediate = join(repoRoot, `.ocx-traversal-${process.pid}`);
    const escapedName = `.ocx-escaped-${process.pid}-${Date.now()}`;
    const escaped = resolve(repoRoot, "..", escapedName);

    // String concatenation, NOT path.join: join() normalises `..` itself, so the script
    // would never receive the traversal that was the actual bypass. Written with join()
    // this test passed against the broken resolver.
    const traversal = `${intermediate}/../../${escapedName}`;

    const { stderr, exitCode } = await runScript(traversal);

    expect(exitCode).not.toBe(0);
    // The message names the RESOLVED path, which is the proof normalisation happened.
    expect(stderr).toContain(escapedName);
    expect(stderr).toContain("Refusing to build into");
    expect(existsSync(escaped)).toBe(false);
    expect(existsSync(intermediate)).toBe(false);
  }, 120_000);

  test("follows a symlink revealed by a .. traversal instead of trusting the link path", async () => {
    const link = join(repoRoot, `.ocx-link-${process.pid}`);
    const missing = join(repoRoot, `.ocx-missing-${process.pid}`);

    const { stderr, exitCode } = await withSandbox(async (sandbox) => {
      const outside = join(sandbox, "outside-target");
      rmSync(link, { recursive: true, force: true });
      symlinkSync(outside, link);
      try {
        // Nothing exists at the missing component, so `..` has to be applied lexically
        // before the symlink can be resolved.
        return await runScript(`${missing}/../${link.split("/").pop()}`);
      } finally {
        rmSync(link, { recursive: true, force: true });
        rmSync(missing, { recursive: true, force: true });
      }
    });

    // The sandbox lives under temp, which is a permitted root, so acceptance is fine.
    // What must never happen is treating the unresolved link path as the destination.
    if (exitCode !== 0) expect(stderr).toContain("Refusing to build into");
    expect(stderr).not.toContain(`${missing}/`);
    expect(existsSync(link)).toBe(false);
    expect(existsSync(missing)).toBe(false);
  }, 300_000);

  test("refuses a symlink that points outside the permitted roots", async () => {
    const link = join(repoRoot, `.ocx-outward-${process.pid}`);
    const outside = join(
      process.env.HOME ?? "/Users/shared",
      `.ocx-symtarget-${process.pid}-${Date.now()}`,
    );

    rmSync(link, { recursive: true, force: true });
    symlinkSync(outside, link);
    try {
      const { stderr, exitCode } = await runScript(link);

      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("Refusing to build into");
      // Named by its physical target, not by the link path inside the repository.
      expect(stderr).toContain(".ocx-symtarget-");
      expect(existsSync(outside)).toBe(false);
    } finally {
      rmSync(link, { recursive: true, force: true });
    }
  }, 120_000);

  test("treats glob characters as literal path components", async () => {
    const target = join(repoRoot, "dist", `ocx-glob-*-${process.pid}`);
    try {
      const { stderr } = await runScript(target);
      expect(stderr).not.toContain("Refusing to build into");
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  }, 300_000);

  test("allows a destination inside the repository", async () => {
    const inside = join(repoRoot, "dist", `ocx-inside-${process.pid}`);
    try {
      const { stderr } = await runScript(inside);
      expect(stderr).not.toContain("Refusing to build into");
    } finally {
      rmSync(inside, { recursive: true, force: true });
    }
  }, 300_000);

  test("allows a temp destination", async () => {
    await withSandbox(async (sandbox) => {
      const { stderr } = await runScript(join(sandbox, "build"));
      expect(stderr).not.toContain("Refusing to build into");
    });
  }, 300_000);
});
