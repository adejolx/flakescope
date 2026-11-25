import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "../..");

/**
 * Test sources for a throwaway project. Each file has a known, deterministic
 * behaviour so tests can assert exact outcomes.
 */
export const SOURCES = {
  "pass.test.ts": `
import { test, expect } from "vitest";
test("passes", () => { expect(1 + 1).toBe(2); });
test.skip("skipped", () => {});
`,
  "fail.test.ts": `
import { test, expect } from "vitest";
test("always fails", () => { expect(1).toBe(2); });
`,
  "order.test.ts": `
import { test, expect } from "vitest";
let session: string | null = null;
test("victim expects logged out", () => { expect(session).toBeNull(); });
test("innocent 1", () => { expect(1).toBe(1); });
test("innocent 2", () => { expect("a" + "b").toBe("ab"); });
test("polluter logs in", () => { session = "alice"; });
test("innocent 3", () => { expect([1].length).toBe(1); });
test("innocent 4", () => { expect(true).toBe(true); });
`,
  "random.test.ts": `
import { test, expect } from "vitest";
test("random below half fails", () => { expect(Math.random()).toBeGreaterThanOrEqual(0.5); });
test("random unaffected", () => { Math.random(); expect(1).toBe(1); });
`,
  "alternating.test.ts": `
import { test, expect } from "vitest";
import { mkdirSync } from "node:fs";
test("alternates", () => {
  let n = 1;
  for (;; n++) {
    try { mkdirSync("run-" + n); break; } catch (e: any) { if (e.code !== "EEXIST") throw e; }
  }
  expect(n % 2).toBe(0);
});
`,
  "overlap.test.ts": `
import { test, expect } from "vitest";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
test("fails when more than two copies run at once", async () => {
  mkdirSync("live", { recursive: true });
  const mark = "live/" + process.pid;
  mkdirSync(mark);
  await new Promise((r) => setTimeout(r, 3000));
  const alive = readdirSync("live").length;
  rmSync(mark, { recursive: true });
  expect(alive).toBeLessThanOrEqual(2);
}, 20000);
`,
  "env.test.ts": `
import { test, expect } from "vitest";
test("sees env", () => { expect(process.env.FLAKESCOPE_TEST_VALUE).toBe("42"); });
`,
  "syntax.test.ts": `this is not valid typescript (((`,
} as const;

export type Project = { dir: string; cleanup: () => void };

/**
 * Creates a throwaway project that reuses this repository's node_modules and
 * holds the given test files.
 * @param names - Keys of SOURCES to write into the project.
 * @returns The project directory (real path) and a cleanup function.
 */
export function createProject(names: (keyof typeof SOURCES)[]): Project {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "flakescope-it-")));
  symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"));
  writeFileSync(
    join(dir, "vitest.config.mts"),
    `import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["*.test.ts"] } });
`,
  );
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  for (const name of names) writeFileSync(join(dir, name), SOURCES[name]);
  mkdirSync(join(dir, ".keep"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
