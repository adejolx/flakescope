// Pure rules over collected evidence. Runs nothing; see classify.test.ts.

import type { Verdict, Interval } from "./stats.ts";

export type Evidence = {
  repeat: { verdict: Verdict; passes: number; fails: number; failRate: Interval };
  order:
    | { verdict: "order-dependent"; seed: number; polluters: string[] }
    | { verdict: "not-order-dependent" };
  random:
    | { verdict: "random-driven"; seed: number }
    | { verdict: "not-random-driven" | "inconclusive" };
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
  // Never passes: a real failure, not a flake.
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

  // The order and Math.random scans run Vitest in parallel, which adds CPU
  // load. If the test is load-sensitive, trust those two less.
  const loadSensitive = e.load.verdict === "load-sensitive";
  const trust: Confidence = loadSensitive ? "medium" : "high";
  const caveat = loadSensitive
    ? ["measured with parallel runs, which add CPU load: less certain"]
    : [];

  const findings: Finding[] = [];

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

  // Flaky, but no probe explains it.
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
