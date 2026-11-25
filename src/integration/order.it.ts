import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { findPolluters, orderProbe } from "../order.ts";
import { makeTestId } from "../run.ts";
import { createProject } from "./project.ts";
import type { Project } from "./project.ts";

let project: Project;
const file = (name: string) => join(project.dir, name);

before(() => {
  project = createProject(["pass.test.ts", "fail.test.ts", "order.test.ts", "alternating.test.ts"]);
  process.chdir(project.dir);
});
after(() => project.cleanup());

test("findPolluters: names the one test that breaks the victim", async () => {
  assert.deepEqual(await findPolluters(file("order.test.ts"), "victim expects logged out"), [
    "polluter logs in",
  ]);
});

test("findPolluters: a victim that fails alone is not an order problem", async () => {
  await assert.rejects(findPolluters(file("fail.test.ts"), "always fails"), /fails on its own/);
});

test("findPolluters: a victim that cannot be made to fail reports that", async () => {
  await assert.rejects(findPolluters(file("pass.test.ts"), "passes"), /cannot reproduce/);
});

test("findPolluters: result does not depend on how many seeds run at once", async () => {
  for (const concurrency of [1, 3]) {
    assert.deepEqual(
      await findPolluters(file("order.test.ts"), "victim expects logged out", concurrency),
      ["polluter logs in"],
    );
  }
});

test("orderProbe: an order-dependent test is confirmed with a seed, failure counts and its polluter", async () => {
  const r = await orderProbe(file("order.test.ts"), makeTestId(file("order.test.ts"), "victim expects logged out"));
  assert.equal(r.verdict, "order-dependent");
  if (r.verdict !== "order-dependent") return;
  assert.ok(r.seed >= 1 && r.seed <= 20);
  assert.ok(r.failures >= 16);
  assert.equal(r.failures, r.reruns);
  assert.deepEqual(r.polluters, ["polluter logs in"]);
});

test("orderProbe: a test that never fails under shuffling is not order-dependent", async () => {
  const r = await orderProbe(file("pass.test.ts"), makeTestId(file("pass.test.ts"), "passes"));
  assert.deepEqual(r, { verdict: "not-order-dependent", detail: "no failure in 20 shuffled runs" });
});

test("orderProbe: a test that fails every time is not order-dependent", async () => {
  const r = await orderProbe(file("fail.test.ts"), makeTestId(file("fail.test.ts"), "always fails"));
  assert.equal(r.verdict, "not-order-dependent");
  if (r.verdict === "not-order-dependent") assert.match(r.detail, /fails on its own/);
});

test("orderProbe: a test that fails under a seed and then passes on rerun is not order-dependent", async () => {
  const r = await orderProbe(file("alternating.test.ts"), makeTestId(file("alternating.test.ts"), "alternates"), 8, 1);
  assert.equal(r.verdict, "not-order-dependent");
  if (r.verdict === "not-order-dependent") assert.match(r.detail, /then passed on a rerun/);
});

test("orderProbe: looks at no more seeds than it was given", async () => {
  const r = await orderProbe(file("pass.test.ts"), makeTestId(file("pass.test.ts"), "passes"), 3);
  assert.deepEqual(r, { verdict: "not-order-dependent", detail: "no failure in 3 shuffled runs" });
});
