import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { runOnce, runMany, unwrap, makeTestId } from "../run.ts";
import { wilson } from "../stats.ts";
import { createProject } from "./project.ts";
import type { Project } from "./project.ts";

let project: Project;
const file = (name: string) => join(project.dir, name);

before(() => {
  project = createProject(["pass.test.ts", "fail.test.ts", "order.test.ts", "env.test.ts", "syntax.test.ts"]);
  process.chdir(project.dir);
});
after(() => project.cleanup());

test("runOnce: reports each test's status, with skipped tests as 'other'", async () => {
  const r = await runOnce([file("pass.test.ts")]);
  assert.equal(r.kind, "ok");
  if (r.kind !== "ok") return;
  const byId = new Map(r.tests.map((t) => [t.id, t.status]));
  assert.equal(byId.get(makeTestId(file("pass.test.ts"), "passes")), "passed");
  assert.equal(byId.get(makeTestId(file("pass.test.ts"), "skipped")), "other");
  assert.equal(r.tests.length, 2);
  for (const t of r.tests) assert.ok(Number.isInteger(t.ms) && t.ms >= 0);
});

test("runOnce: a failing test is reported as failed", async () => {
  const tests = unwrap(await runOnce([file("fail.test.ts")]));
  assert.deepEqual(tests.map((t) => [t.id, t.status]), [
    [makeTestId(file("fail.test.ts"), "always fails"), "failed"],
  ]);
});

test("runOnce: with no files, runs every test file in the project", async () => {
  const ids = new Set(unwrap(await runOnce(["pass.test.ts", "fail.test.ts"])).map((t) => t.id));
  assert.ok(ids.has(makeTestId(file("pass.test.ts"), "passes")));
  assert.ok(ids.has(makeTestId(file("fail.test.ts"), "always fails")));
});

test("runOnce: extra Vitest args are applied", async () => {
  const tests = unwrap(await runOnce([file("order.test.ts")], ["-t", "^innocent 1$"]));
  const status = (name: string) => tests.find((t) => t.id === makeTestId(file("order.test.ts"), name))?.status;
  assert.equal(status("innocent 1"), "passed");
  assert.equal(status("victim expects logged out"), "other");
});

test("runOnce: env vars reach the tests", async () => {
  const without = unwrap(await runOnce([file("env.test.ts")]));
  const withEnv = unwrap(await runOnce([file("env.test.ts")], [], { FLAKESCOPE_TEST_VALUE: "42" }));
  assert.equal(without[0].status, "failed");
  assert.equal(withEnv[0].status, "passed");
});

test("runOnce: a file that cannot be loaded yields no tests, which unwrap rejects", async () => {
  const r = await runOnce([file("syntax.test.ts")]);
  assert.equal(r.kind, "ok");
  assert.throws(() => unwrap(r), /Zero results/);
});

test("runOnce: Vitest dying before it writes a report is a crash with stderr", async () => {
  const r = await runOnce([file("pass.test.ts")], ["--config=does-not-exist.mts"]);
  assert.equal(r.kind, "crash");
  if (r.kind === "crash") assert.ok(r.stderr.length > 0);
  assert.throws(() => unwrap(r), /A crash is not a flake/);
});

test("runOnce: outside a project with Vitest installed, says where it looked", async () => {
  const empty = mkdtempSync(join(tmpdir(), "flakescope-empty-"));
  const back = process.cwd();
  try {
    process.chdir(empty);
    await assert.rejects(runOnce(["x.test.ts"]), /Cannot find .*node_modules\/vitest/);
  } finally {
    process.chdir(back);
    rmSync(empty, { recursive: true, force: true });
  }
});

test("runMany: counts passes per test and leaves a short run undecided", async () => {
  const s = await runMany(3, [file("pass.test.ts")]);
  const passes = s.find((x) => x.id === makeTestId(file("pass.test.ts"), "passes"))!;
  assert.equal(passes.passes, 3);
  assert.equal(passes.fails, 0);
  assert.equal(passes.verdict, "undecided");
  assert.deepEqual(passes.failRate, wilson(0, 3));
  assert.equal(passes.failMedianMs, undefined);
  assert.equal(typeof passes.passMedianMs, "number");
});

test("runMany: a skipped test counts as neither pass nor fail and has the full fail-rate range", async () => {
  const s = await runMany(2, [file("pass.test.ts")]);
  const skipped = s.find((x) => x.id === makeTestId(file("pass.test.ts"), "skipped"))!;
  assert.equal(skipped.passes + skipped.fails, 0);
  assert.deepEqual(skipped.failRate, { low: 0, high: 1 });
});

test("runMany: a test that never passes is declared broken after 16 fails, and runs stop there", async () => {
  const [s] = await runMany(100, [file("fail.test.ts")]);
  assert.equal(s.verdict, "broken");
  assert.equal(s.passes, 0);
  assert.equal(s.fails, 16);
  assert.equal(s.passMedianMs, undefined);
});

test("runMany: never runs more suites than the budget, even when the budget is odd", async () => {
  const s = await runMany(3, [file("fail.test.ts")]);
  assert.equal(s[0].fails, 3);
});

test("runMany: a test that passes 35 times in a row is declared clean, and runs stop there", { timeout: 300000 }, async () => {
  const [s] = await runMany(100, [join(project.dir, "order.test.ts")].slice(0, 1));
  assert.equal(s.verdict, "clean");
  assert.ok(s.passes >= 35 && s.passes <= 36);
});
