// Run with: node --test src/classify.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { classify } from "./classify.ts";
import type { Evidence } from "./classify.ts";

const range = (low: number, high: number) => ({ low, high });

// A baseline with nothing wrong. Each test overrides only what it needs.
const quiet: Evidence = {
  scanConcurrency: 4,
  repeat: { verdict: "clean", passes: 35, fails: 0, failRate: range(0, 0.1) },
  order: { verdict: "not-order-dependent" },
  random: { verdict: "inconclusive" },
  load: { verdict: "no-load-effect", alone: range(0, 0.39), loaded: range(0, 0.19) },
};

test("clean test with no evidence: cause none", () => {
  const [f] = classify(quiet);
  assert.equal(f.cause, "none");
});

test("never passes: deterministic failure, and nothing else is reported", () => {
  const findings = classify({
    ...quiet,
    repeat: { verdict: "broken", passes: 0, fails: 16, failRate: range(0.8, 1) },
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].cause, "deterministic-failure");
});

test("order dependence names the polluter", () => {
  const [f] = classify({
    ...quiet,
    order: { verdict: "order-dependent", seed: 3, polluters: ["writer"] },
  });
  assert.equal(f.cause, "order-dependence");
  assert.equal(f.confidence, "high");
  assert.ok(f.because.some((line) => line.includes("writer")));
});

test("Math.random drives a flaky test", () => {
  const [f] = classify({
    ...quiet,
    repeat: { verdict: "flaky", passes: 6, fails: 14, failRate: range(0.4, 0.8) },
    random: { verdict: "random-driven", seed: 1 },
  });
  assert.equal(f.cause, "math-random");
});

test("cpu load is reported with high confidence", () => {
  const [f] = classify({
    ...quiet,
    load: { verdict: "load-sensitive", alone: range(0, 0.39), loaded: range(0.81, 1) },
  });
  assert.equal(f.cause, "cpu-load");
  assert.equal(f.confidence, "high");
});

test("load-sensitive test: order and random findings drop to medium", () => {
  const findings = classify({
    ...quiet,
    order: { verdict: "order-dependent", seed: 3, polluters: [] },
    load: { verdict: "load-sensitive", alone: range(0, 0.39), loaded: range(0.81, 1) },
  });
  const order = findings.find((f) => f.cause === "order-dependence");
  assert.equal(order?.confidence, "medium");
  // High confidence findings come first.
  assert.equal(findings[0].cause, "cpu-load");
});

test("flaky but unexplained: unknown, low confidence", () => {
  const [f] = classify({
    ...quiet,
    repeat: { verdict: "flaky", passes: 20, fails: 2, failRate: range(0.03, 0.3) },
  });
  assert.equal(f.cause, "unknown");
  assert.equal(f.confidence, "low");
});

test("failures take far longer than passes: wait-timeout", () => {
  const findings = classify({
    ...quiet,
    repeat: {
      verdict: "flaky",
      passes: 33,
      fails: 3,
      failRate: range(0.03, 0.22),
      passMedianMs: 200,
      failMedianMs: 1230,
    },
  });
  assert.equal(findings[0].cause, "wait-timeout");
  assert.equal(findings[0].confidence, "high");
  assert.match(findings[0].because[0], /1230 ms.*200 ms/);
});

test("only 2 failures: wait-timeout is medium confidence", () => {
  const [f] = classify({
    ...quiet,
    repeat: {
      verdict: "flaky",
      passes: 22,
      fails: 2,
      failRate: range(0.02, 0.26),
      passMedianMs: 200,
      failMedianMs: 5200,
    },
  });
  assert.equal(f.cause, "wait-timeout");
  assert.equal(f.confidence, "medium");
});

test("failures only a bit slower than passes: no wait-timeout", () => {
  const [f] = classify({
    ...quiet,
    repeat: {
      verdict: "flaky",
      passes: 20,
      fails: 5,
      failRate: range(0.1, 0.4),
      passMedianMs: 120,
      failMedianMs: 340, // 2.8x: slow, but not a timeout
    },
  });
  assert.equal(f.cause, "unknown");
});

test("durations unknown: no wait-timeout", () => {
  const [f] = classify({
    ...quiet,
    repeat: { verdict: "flaky", passes: 20, fails: 5, failRate: range(0.1, 0.4) },
  });
  assert.equal(f.cause, "unknown");
});

test("load-sensitive but scans ran one at a time: order finding stays high", () => {
  const findings = classify({
    ...quiet,
    scanConcurrency: 1,
    order: { verdict: "order-dependent", seed: 3, polluters: ["writer"] },
    load: { verdict: "load-sensitive", alone: range(0, 0.1), loaded: range(0.8, 1) },
  });
  const order = findings.find((f) => f.cause === "order-dependence");
  assert.equal(order?.confidence, "high");
  assert.ok(!order?.because.some((line) => line.includes("parallel")));
});
