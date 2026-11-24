export type Verdict = "broken" | "flaky" | "clean" | "undecided";
export type Interval = { low: number; high: number };

// Step 2: the calculator.
// Input:  how many runs failed, how many runs total.
// Output: the range the true fail rate probably sits in (95% sure).
// Black box: you don't need to follow the formula, only the in/out.
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

// Step 3: the decider.
// Input:  passes and fails seen so far for ONE test.
// Output: one word. First matching rule wins.
export function decide(
  passes: number,
  fails: number,
  opts: { cleanBelow: number; brokenAbove: number } = {
    cleanBelow: 0.1,
    brokenAbove: 0.8,
  },
): Verdict {
  // Saw both a pass and a fail: proven flaky. Nothing more to learn.
  if (passes > 0 && fails > 0) return "flaky";

  // Never passed, and the range's BOTTOM end is high enough: broken.
  // A few fails in a row proves nothing: a test that fails 65% of the time
  // fails 3 in a row about 27% of the time. 16 fails in a row clears 80%.
  if (passes === 0 && fails > 0 && wilson(fails, fails).low > opts.brokenAbove) {
    return "broken";
  }

  // Never failed, and the range's top end is small enough: clean.
  if (fails === 0 && passes > 0 && wilson(0, passes).high < opts.cleanBelow) {
    return "clean";
  }

  // Not enough evidence yet.
  return "undecided";
}
