import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { createProject } from "./project.ts";
import type { Project } from "./project.ts";

const CLI = resolve(import.meta.dirname, "../cli.ts");
const run = promisify(execFile);

let project: Project;

async function cli(...args: string[]) {
  try {
    const { stdout } = await run(process.execPath, [CLI, ...args], { cwd: project.dir });
    return { code: 0, stdout };
  } catch (e) {
    const err = e as { code: number; stdout: string };
    return { code: err.code, stdout: err.stdout };
  }
}

before(() => {
  project = createProject(["pass.test.ts", "fail.test.ts", "order.test.ts", "random.test.ts"]);
});
after(() => project.cleanup());

test("diagnose --json: prints a parseable report and exits 1 when a problem is found", async () => {
  const { code, stdout } = await cli("diagnose", "fail.test.ts", "always fails", "--json");
  assert.equal(code, 1);
  const report = JSON.parse(stdout);
  assert.equal(report.schemaVersion, 1);
  assert.deepEqual([report.test.file, report.test.name], ["fail.test.ts", "always fails"]);
  assert.equal(report.hasProblem, true);
  assert.equal(report.findings[0].cause, "deterministic-failure");
  assert.equal(report.findings[0].reproduce, "npx vitest run fail.test.ts");
});

test("diagnose: the text report names the cause, evidence and fix", async () => {
  const { code, stdout } = await cli("diagnose", "fail.test.ts", "always fails");
  assert.equal(code, 1);
  assert.match(stdout, /DETERMINISTIC-FAILURE {2}\(high confidence\)/);
  assert.match(stdout, /failed 16 of 16 runs and never passed/);
  assert.match(stdout, /fix: /);
});

test("diagnose: missing arguments print usage and exit 0", async () => {
  const none = await cli("diagnose");
  const one = await cli("diagnose", "fail.test.ts");
  for (const r of [none, one]) {
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^Usage: node src\/cli\.ts diagnose /);
  }
});

test("order: names each order-dependent test and its polluter", async () => {
  const { code, stdout } = await cli("order", "order.test.ts");
  assert.equal(code, 0);
  assert.match(stdout, /^order-dependent {2}victim expects logged out {2}\(seed \d+, fails 16\/16\)/m);
  assert.match(stdout, /^ {2}polluted by: polluter logs in$/m);
});

test("order: a file with no order dependence says so", async () => {
  const { stdout } = await cli("order", "pass.test.ts");
  assert.equal(stdout.trim(), "no order dependence found in 20 seeds");
});

test("order: missing file prints usage", async () => {
  assert.match((await cli("order")).stdout, /^Usage: node src\/cli\.ts order /);
});

test("probe: reports the Math.random and CPU-load verdicts for a test", async () => {
  const { stdout } = await cli("probe", "random.test.ts", "random below half fails");
  assert.match(stdout, /^probing: random below half fails$/m);
  assert.match(stdout, /^Math\.random {3}DRIVES the flake {2}\(seed \d+, fails 16\/16\)$/m);
  assert.match(stdout, /^CPU load {6}no load effect {2}\(alone \d\/6 fails, \d+%\.\.\d+%; loaded \d+\/16 fails, \d+%\.\.\d+%\)$/m);
});

test("probe: missing arguments print usage", async () => {
  assert.match((await cli("probe", "random.test.ts")).stdout, /^Usage: node src\/cli\.ts probe /);
});

test("repeat: prints a verdict line per test and a run summary", async () => {
  const { code, stdout } = await cli("3");
  assert.equal(code, 0);
  assert.match(stdout, /^undecided 3\/3 {2}fail rate 0%\.\.\d+% {2}\S+pass\.test\.ts\0passes$/m);
  assert.match(stdout, /^undecided 0\/3 {2}fail rate \d+%\.\.100% {2}\S+fail\.test\.ts\0always fails$/m);
  assert.match(stdout, /^3 runs, \d+ test executions \(fixed would be \d+\), [\d.]+s$/m);
});
