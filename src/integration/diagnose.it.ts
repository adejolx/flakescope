import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { diagnose } from "../diagnose.ts";
import { CONCURRENCY } from "../order.ts";
import { makeTestId } from "../run.ts";
import { createProject } from "./project.ts";
import type { Project } from "./project.ts";

let project: Project;
const file = (name: string) => join(project.dir, name);

before(() => {
  project = createProject(["fail.test.ts", "order.test.ts", "pass.test.ts"]);
  process.chdir(project.dir);
});
after(() => project.cleanup());

test("diagnose: a test that never passes is a deterministic failure, with no probes run", async () => {
  const id = makeTestId(file("fail.test.ts"), "always fails");
  const d = await diagnose(file("fail.test.ts"), id);
  assert.equal(d.testId, id);
  assert.equal(d.evidence.repeat.verdict, "broken");
  assert.equal(d.evidence.scanConcurrency, 1);
  assert.deepEqual(d.findings.map((f) => f.cause), ["deterministic-failure"]);
});

test("diagnose: an unknown test id is rejected with a message naming it", async () => {
  const id = makeTestId(file("pass.test.ts"), "no such test");
  const started = Date.now();
  await assert.rejects(diagnose(file("pass.test.ts"), id), /No test with id .*no such test/);
  assert.ok(Date.now() - started < 20000, "should fail after one run, not after the repeat runs");
});

test("diagnose: an order-dependent test is traced to its polluter", { timeout: 600000 }, async () => {
  const id = makeTestId(file("order.test.ts"), "victim expects logged out");
  const d = await diagnose(file("order.test.ts"), id);
  assert.equal(d.evidence.repeat.verdict, "clean");
  assert.equal(d.evidence.scanConcurrency, CONCURRENCY);
  assert.equal(d.evidence.order.verdict, "order-dependent");
  assert.equal(d.findings[0].cause, "order-dependence");
  assert.equal(d.findings[0].confidence, "high");
  assert.ok(d.findings[0].because.some((l) => l.includes("polluter logs in")));
});
