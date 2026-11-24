export type Verdict = "broken" | "flaky" | "clean" | "undecided";
export type Interval = { low: number; high: number };

// Wilson score interval: the range the true fail rate sits in, 95% sure.
export function wilson(fails: number, n: number, z = 1.96): Interval {
  const p = fails / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const margin =
    (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return {
    low: Math.max(0, center - margin),
    high: Math.min(1, center + margin),
  };
}

// One verdict for one test. First matching rule wins.
export function decide(
  passes: number,
  fails: number,
  opts: { cleanBelow: number; brokenAbove: number } = {
    cleanBelow: 0.1,
    brokenAbove: 0.8,
  },
): Verdict {
  // A pass and a fail: proven flaky.
  if (passes > 0 && fails > 0) return "flaky";

  // A few fails in a row prove nothing: a 65% flake fails 3 in a row about
  // 27% of the time. 16 in a row clears 80%.
  if (passes === 0 && fails > 0 && wilson(fails, fails).low > opts.brokenAbove) {
    return "broken";
  }

  // 35 passes in a row bring the high end under 10%.
  if (fails === 0 && passes > 0 && wilson(0, passes).high < opts.cleanBelow) {
    return "clean";
  }

  return "undecided";
}
