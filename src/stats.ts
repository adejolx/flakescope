export type Verdict = "broken" | "flaky" | "clean" | "undecided";
export type Interval = { low: number; high: number };

/**
 * Formats a fraction as a whole-number percentage, e.g. 0.256 -> "26%".
 * @param fraction - Value between 0 and 1.
 * @returns The percentage string.
 */
export function formatPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(0)}%`;
}

/**
 * Wilson score confidence interval for a binomial proportion.
 * @param fails - Number of failures observed.
 * @param n - Total number of runs.
 * @param z - Normal quantile; 1.96 gives a 95% interval.
 * @returns The range, clamped to [0, 1], that likely contains the true fail rate;
 * the full range [0, 1] when n is not positive (no information).
 */
export function wilson(fails: number, n: number, z = 1.96): Interval {
  if (!(n > 0)) return { low: 0, high: 1 };
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

/**
 * Turns pass/fail counts into one verdict. The first matching rule wins:
 * both outcomes seen is "flaky"; enough consecutive fails is "broken"; enough
 * consecutive passes is "clean"; anything else is "undecided".
 * @param passes - Number of passing runs.
 * @param fails - Number of failing runs.
 * @param opts - cleanBelow: upper fail-rate bound required for "clean";
 * brokenAbove: lower fail-rate bound required for "broken".
 * @returns The verdict.
 */
export function decide(
  passes: number,
  fails: number,
  opts: { cleanBelow: number; brokenAbove: number } = {
    cleanBelow: 0.1,
    brokenAbove: 0.8,
  },
): Verdict {

  if (passes > 0 && fails > 0) return "flaky";

  if (passes === 0 && fails > 0 && wilson(fails, fails).low > opts.brokenAbove) {
    return "broken";
  }

  if (fails === 0 && passes > 0 && wilson(0, passes).high < opts.cleanBelow) {
    return "clean";
  }

  return "undecided";
}

/**
 * Median of a list, so one slow outlier does not move it.
 * @param values - Numbers in any order; not mutated.
 * @returns The middle value (mean of the two middle values for an even
 * count), or undefined for an empty list.
 */
export function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}
