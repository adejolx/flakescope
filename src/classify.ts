import type { Verdict, Interval } from "./stats.ts";

export type Evidence = {

  scanConcurrency: number;
  repeat: {
    verdict: Verdict;
    passes: number;
    fails: number;
    failRate: Interval;

    passMedianMs?: number;
    failMedianMs?: number;
  };
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
  | "wait-timeout"
  | "unknown"
  | "none";

export type Confidence = "high" | "medium" | "low";

export type Finding = {
  cause: Cause;
  confidence: Confidence;
  because: string[];
  suggestion: string;
};

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const range = (r: Interval) => `${pct(r.low)}..${pct(r.high)}`;

const CONFIDENCE_RANK: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };

/**
 * Detects the "wait timed out" signature: failing runs take at least 4x and at
 * least 200 ms longer than passing runs.
 * @param r - Repeat-run evidence.
 * @returns The typical pass and fail durations when the pattern holds, else undefined.
 */
function timeoutPattern(
  r: Evidence["repeat"],
): { passMs: number; failMs: number } | undefined {
  if (r.verdict !== "flaky") return undefined;
  if (r.passMedianMs === undefined || r.failMedianMs === undefined) return undefined;
  const passMs = r.passMedianMs;
  const failMs = r.failMedianMs;
  if (failMs >= 4 * Math.max(passMs, 1) && failMs - passMs >= 200) {
    return { passMs, failMs };
  }
  return undefined;
}

/**
 * Applies the diagnosis rules to collected evidence.
 * A test that never passes is a deterministic failure and nothing else is
 * reported. Otherwise every cause the evidence supports is returned, most
 * confident first; if none applies the result is "unknown" (flaky) or "none".
 * Order and Math.random findings are downgraded to medium confidence when the
 * test is load-sensitive and the scans ran in parallel.
 * @param e - Evidence from the repeat runs and the probes.
 * @returns At least one finding, sorted by confidence.
 */
export function classify(e: Evidence): Finding[] {

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

  const loadSensitive = e.load.verdict === "load-sensitive";
  const confounded = loadSensitive && e.scanConcurrency > 1;
  const trust: Confidence = confounded ? "medium" : "high";
  const caveat = confounded
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

  const slow = timeoutPattern(e.repeat);
  if (slow !== undefined) {
    const times = Math.round(slow.failMs / Math.max(slow.passMs, 1));
    findings.push({
      cause: "wait-timeout",

      confidence: e.repeat.fails >= 3 ? "high" : "medium",
      because: [
        `failing runs take about ${slow.failMs} ms, passing runs about ${slow.passMs} ms (${times}x)`,
        "two clusters, fast or timed out: the awaited update sometimes never arrives",
      ],
      suggestion:
        "A wait is timing out. Raising the timeout will not fix it, because in " +
        "the failing runs the update never arrives. Find why it sometimes does " +
        "not happen: a missing await, an event fired before its listener exists, " +
        "or state set outside act().",
    });
  }

  if (findings.length > 0) {
    return findings.sort(
      (a, b) => CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence],
    );
  }

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
