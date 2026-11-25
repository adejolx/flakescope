import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomSeedProbe, loadProbe } from "../perturb.ts";
import { makeTestId } from "../run.ts";
import { createProject } from "./project.ts";
import type { Project } from "./project.ts";

let project: Project;
const file = (name: string) => join(project.dir, name);
const id = (f: string, name: string) => makeTestId(file(f), name);

before(() => {
  project = createProject(["pass.test.ts", "random.test.ts", "alternating.test.ts", "overlap.test.ts"]);
  process.chdir(project.dir);
});
after(() => project.cleanup());

test("randomSeedProbe: a test that fails for some Math.random values is random-driven, with a reproducing seed", async () => {
  const r = await randomSeedProbe(file("random.test.ts"), id("random.test.ts", "random below half fails"));
  assert.equal(r.verdict, "random-driven");
  if (r.verdict !== "random-driven") return;
  assert.ok(r.seed >= 1 && r.seed <= 16);
  assert.ok(r.failures >= 16);
  assert.equal(r.failures, r.reruns);
});

test("randomSeedProbe: a test that ignores Math.random is inconclusive and reports how many seeds it tried", async () => {
  const r = await randomSeedProbe(file("random.test.ts"), id("random.test.ts", "random unaffected"), 5);
  assert.deepEqual(r, { verdict: "inconclusive", seedsTried: 5 });
});

test("randomSeedProbe: a failure that changes between reruns of one seed is not random-driven", async () => {
  const r = await randomSeedProbe(file("alternating.test.ts"), id("alternating.test.ts", "alternates"), 8, 1);
  assert.equal(r.verdict, "not-random-driven");
});

test("randomSeedProbe: writes its config into the project's .flakescope folder", async () => {
  await randomSeedProbe(file("random.test.ts"), id("random.test.ts", "random unaffected"), 1);
  assert.ok(existsSync(join(project.dir, ".flakescope", "random.config.mts")));
  assert.ok(existsSync(join(project.dir, ".flakescope", "random-setup.ts")));
});

test("randomSeedProbe: fails clearly when the project has no Vitest or Vite config", async () => {
  const bare = mkdtempSync(join(tmpdir(), "flakescope-bare-"));
  const back = process.cwd();
  try {
    process.chdir(bare);
    await assert.rejects(randomSeedProbe("x.test.ts", "x::y", 1), /No vitest\.config\.\* or vite\.config\.\*/);
  } finally {
    process.chdir(back);
    rmSync(bare, { recursive: true, force: true });
  }
});

test("loadProbe: a test that passes however busy the machine is shows no load effect", async () => {
  const r = await loadProbe(file("pass.test.ts"), id("pass.test.ts", "passes"));
  assert.equal(r.verdict, "no-load-effect");
  assert.deepEqual([r.alone.fails, r.alone.runs, r.loaded.fails, r.loaded.runs], [0, 6, 0, 16]);
});

test("loadProbe: a test that fails only when copies run together is load-sensitive", async () => {
  const r = await loadProbe(file("overlap.test.ts"), id("overlap.test.ts", "fails when more than two copies run at once"));
  assert.equal(r.verdict, "load-sensitive");
  assert.equal(r.alone.fails, 0);
  assert.ok(r.loaded.range.low > r.alone.range.high);
});

test("loadProbe: earlier runs are reused as the baseline instead of rerunning", async () => {
  const r = await loadProbe(file("pass.test.ts"), id("pass.test.ts", "passes"), { fails: 3, runs: 10 });
  assert.deepEqual([r.alone.fails, r.alone.runs], [3, 10]);
});
