import { test } from "node:test";
import assert from "node:assert/strict";
import { classify } from "./classify.ts";
import type { Evidence } from "./classify.ts";

const range = (low: number, high: number) => ({ low, high });

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
      failMedianMs: 340,
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

import fc from "fast-check";
import { evidence } from "./evidence.arb.ts";

const RANK = { high: 0, medium: 1, low: 2 } as const;

test("property: always at least one finding, each with evidence and a suggestion", () => {
  fc.assert(
    fc.property(evidence, (e) => {
      const findings = classify(e);
      return (
        findings.length > 0 &&
        findings.every((f) => f.because.length > 0 && f.suggestion.length > 0)
      );
    }),
  );
});

test("property: findings are sorted most confident first and no cause repeats", () => {
  fc.assert(
    fc.property(evidence, (e) => {
      const findings = classify(e);
      const causes = findings.map((f) => f.cause);
      const sorted = findings.every(
        (f, i) => i === 0 || RANK[findings[i - 1].confidence] <= RANK[f.confidence],
      );
      return sorted && new Set(causes).size === causes.length;
    }),
  );
});

test("property: a test that never passes yields only deterministic-failure, whatever the probes say", () => {
  fc.assert(
    fc.property(evidence, (e) => {
      const findings = classify({ ...e, repeat: { ...e.repeat, verdict: "broken" } });
      return findings.length === 1 && findings[0].cause === "deterministic-failure";
    }),
  );
});

test("property: unknown and none never appear next to a real cause", () => {
  fc.assert(
    fc.property(evidence, (e) => {
      const findings = classify(e);
      const filler = findings.filter((f) => f.cause === "unknown" || f.cause === "none");
      return filler.length === 0 || findings.length === 1;
    }),
  );
});

test("property: each probe that found something is reported", () => {
  fc.assert(
    fc.property(evidence, (e) => {
      if (e.repeat.verdict === "broken") return true;
      const causes = classify(e).map((f) => f.cause);
      return (
        (e.order.verdict !== "order-dependent" || causes.includes("order-dependence")) &&
        (e.random.verdict !== "random-driven" || causes.includes("math-random")) &&
        (e.load.verdict !== "load-sensitive" || causes.includes("cpu-load"))
      );
    }),
  );
});

test("property: running scans one at a time never lowers confidence", () => {
  fc.assert(
    fc.property(evidence, (e) => {
      if (e.repeat.verdict === "broken") return true;
      const quietRun = classify({ ...e, scanConcurrency: 1 });
      const parallel = classify({ ...e, scanConcurrency: 4 });
      return quietRun.every((f) => {
        const p = parallel.find((g) => g.cause === f.cause);
        return p !== undefined && RANK[f.confidence] <= RANK[p.confidence];
      });
    }),
  );
});

const flakyWith = (passMedianMs: number, failMedianMs: number): Evidence => ({
  ...quiet,
  repeat: { verdict: "flaky", passes: 30, fails: 5, failRate: range(0.05, 0.3), passMedianMs, failMedianMs },
});
const isTimeout = (e: Evidence) => classify(e).some((f) => f.cause === "wait-timeout");

test("wait-timeout threshold: exactly 4x and exactly 200 ms more is a timeout", () => {
  assert.equal(isTimeout(flakyWith(50, 250)), true);
  assert.equal(isTimeout(flakyWith(200, 800)), true);
});

test("wait-timeout threshold: just under 200 ms more is not a timeout", () => {
  assert.equal(isTimeout(flakyWith(50, 249)), false);
  assert.equal(isTimeout(flakyWith(10, 40)), false);
});

test("wait-timeout threshold: just under 4x is not a timeout, however large the gap", () => {
  assert.equal(isTimeout(flakyWith(1000, 3999)), false);
  assert.equal(isTimeout(flakyWith(1000, 4000)), true);
});

test("wait-timeout threshold: a zero pass time counts as 1 ms", () => {
  assert.equal(isTimeout(flakyWith(0, 200)), true);
  assert.equal(isTimeout(flakyWith(0, 199)), false);
});

test("property: wait-timeout is never reported for a test that is not flaky", () => {
  fc.assert(
    fc.property(evidence, (e) => {
      if (e.repeat.verdict === "flaky") return true;
      return !classify(e).some((f) => f.cause === "wait-timeout");
    }),
  );
});
