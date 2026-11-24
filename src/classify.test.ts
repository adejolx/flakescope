// Tests for classify(). Run with:  node --test src/classify.test.ts
// node:test is built into Node, so this needs no extra package.
// We hand-build the evidence, so each test runs in milliseconds.

import { test } from "node:test";
import assert from "node:assert/strict";
import { classify } from "./classify.ts";
import type { Evidence } from "./classify.ts";

const range = (low: number, high: number) => ({ low, high });

// A baseline with nothing wrong. Each test overrides only what it needs.
const quiet: Evidence = {
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
