// Layer 5: turn evidence into a diagnosis.
//
// This file does NO running and touches no files. It takes the numbers the
// earlier layers collected and applies rules. That makes it instant to run
// and easy to test: see classify.test.ts.
//
//   gather evidence (slow, runs Vitest)   ->  diagnose.ts
//   judge the evidence (instant, pure)    ->  this file

import type { Verdict, Interval } from "./stats.ts";

export type Evidence = {
  // Layer 2: running the test over and over.
  repeat: { verdict: Verdict; passes: number; fails: number; failRate: Interval };
  // Layer 3: shuffling test order.
  order:
    | { verdict: "order-dependent"; seed: number; polluters: string[] }
    | { verdict: "not-order-dependent" };
  // Layer 4: fixing Math.random.
  random:
    | { verdict: "random-driven"; seed: number }
    | { verdict: "not-random-driven" | "inconclusive" };
  // Layer 4: putting the CPU under load.
  load: {
    verdict: "load-sensitive" | "no-load-effect";
    alone: Interval;
    loaded: Interval;
  };
};

export type Cause =
  | "deterministic-failure"
  | "order-dependence"
  | "math-random"
  | "cpu-load"
  | "unknown"
  | "none";

export type Confidence = "high" | "medium" | "low";

export type Finding = {
  cause: Cause;
  confidence: Confidence;
  because: string[]; // the evidence, one short line each
  suggestion: string; // what to do about it
};

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const range = (r: Interval) => `${pct(r.low)}..${pct(r.high)}`;

const CONFIDENCE_RANK: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };

export function classify(e: Evidence): Finding[] {
  // Rule 1: it never passes. That is a real failure, not a flake.
  if (e.repeat.verdict === "broken") {
    const runs = e.repeat.passes + e.repeat.fails;
    return [
      {
        cause: "deterministic-failure",
        confidence: "high",
        because: [`failed ${e.repeat.fails} of ${runs} runs and never passed`],
        suggestion: "This is a real failure, not a flake. Fix the test or the code.",
      },
    ];
  }

  // A catch: the order scan and the Math.random scan run several copies of
  // Vitest at once, and that adds CPU load. If the test is load-sensitive, a
  // failure seen there might be caused by the load, so trust those two less.
  const loadSensitive = e.load.verdict === "load-sensitive";
  const trust: Confidence = loadSensitive ? "medium" : "high";
  const caveat = loadSensitive
    ? ["measured with parallel runs, which add CPU load: less certain"]
    : [];

  const findings: Finding[] = [];

  // Rule 2: fails every time under one shuffle seed.
  if (e.order.verdict === "order-dependent") {
    const who =
      e.order.polluters.length === 0
        ? "polluter not found"
        : `polluted by: ${e.order.polluters.join(", ")}`;
    const first = e.order.polluters[0] ?? "another test in the file";
    findings.push({
      cause: "order-dependence",
      confidence: trust,
      because: [`fails every time under shuffle seed ${e.order.seed}`, who, ...caveat],
      suggestion:
        `Shared state leaks between tests. Reset it in a beforeEach/afterEach, ` +
        `starting with whatever "${first}" changes.`,
    });
  }

  // Rule 3: fails every time under one Math.random seed.
  if (e.random.verdict === "random-driven") {
    findings.push({
      cause: "math-random",
      confidence: trust,
      because: [`fails every time with Math.random fixed to seed ${e.random.seed}`, ...caveat],
      suggestion:
        "The result depends on Math.random. Stub it with " +
        'vi.spyOn(Math, "random").mockReturnValue(0.5), or assert on something ' +
        "that does not depend on the random value.",
    });
  }

  // Rule 4: the fail rate jumps under CPU load.
  if (loadSensitive) {
    findings.push({
      cause: "cpu-load",
      confidence: "high",
      because: [
        `fail rate ${range(e.load.alone)} alone, ${range(e.load.loaded)} under load`,
      ],
      suggestion:
        "The test depends on how fast the machine is. Do not compare " +
        "performance.now() against a fixed budget in a unit test. Use fake " +
        "timers, or assert on behavior and measure speed in a separate benchmark.",
    });
  }

  if (findings.length > 0) {
    return findings.sort(
      (a, b) => CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence],
    );
  }

  // Rule 5: flaky, but no probe explains it.
  if (e.repeat.verdict === "flaky") {
    return [
      {
        cause: "unknown",
        confidence: "low",
        because: [
          `flaky: fail rate ${range(e.repeat.failRate)}`,
          "not order, not Math.random, not CPU load",
        ],
        suggestion:
          "Likely a real timer, a network call or an async race. " +
          "Next: wait on a condition (waitFor) instead of a fixed sleep, and " +
          "check for unmocked network requests.",
      },
    ];
  }

  // Rule 6: nothing wrong seen.
  return [
    {
      cause: "none",
      confidence: e.repeat.verdict === "clean" ? "medium" : "low",
      because: [
        e.repeat.verdict === "clean"
          ? `no failures; fail rate below ${pct(e.repeat.failRate.high)}`
          : "not enough runs to decide",
      ],
      suggestion: "No flake observed.",
    },
  ];
}
