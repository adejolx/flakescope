import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { wilson, decide, median } from "./stats.ts";

const runs = fc.integer({ min: 1, max: 5000 }).chain((n) =>
  fc.tuple(fc.integer({ min: 0, max: n }), fc.constant(n)),
);

test("wilson: interval lies in [0, 1], is ordered, and contains the observed rate", () => {
  fc.assert(
    fc.property(runs, ([fails, n]) => {
      const { low, high } = wilson(fails, n);
      const p = fails / n;
      return 0 <= low && low <= p + 1e-12 && p <= high + 1e-12 && high <= 1;
    }),
  );
});

test("wilson: more runs at the same observed rate give a narrower interval", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 200 }),
      fc.integer({ min: 0, max: 100 }),
      fc.integer({ min: 2, max: 20 }),
      (n, pct, k) => {
        const fails = Math.floor((n * pct) / 100);
        const small = wilson(fails, n);
        const big = wilson(fails * k, n * k);
        return big.high - big.low <= small.high - small.low + 1e-12;
      },
    ),
  );
});

test("wilson: no failures gives a lower bound of zero", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 5000 }), (n) => wilson(0, n).low < 1e-12));
});

test("decide: a pass and a fail is always flaky", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 1000 }), fc.integer({ min: 1, max: 1000 }), (p, f) =>
      decide(p, f) === "flaky",
    ),
  );
});

test("decide: no runs at all is undecided", () => {
  assert.equal(decide(0, 0), "undecided");
});

test("decide: failing without ever passing is broken from 16 fails, undecided before", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 500 }), (f) =>
      decide(0, f) === (f >= 16 ? "broken" : "undecided"),
    ),
  );
});

test("decide: passing without ever failing is clean from 35 passes, undecided before", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 500 }), (p) =>
      decide(p, 0) === (p >= 35 ? "clean" : "undecided"),
    ),
  );
});

test("decide: stricter thresholds never turn undecided into a verdict", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 500 }), (p) => {
      const strict = decide(p, 0, { cleanBelow: 0.01, brokenAbove: 0.99 });
      return strict === "undecided" || decide(p, 0) === "clean";
    }),
  );
});

test("median: empty list has no median", () => {
  assert.equal(median([]), undefined);
});

test("median: known values", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([7]), 7);
});

test("median: independent of order and bounded by min and max", () => {
  fc.assert(
    fc.property(
      fc.array(fc.integer({ min: -1e6, max: 1e6 }), { minLength: 1 }),
      (xs) => {
        const m = median(xs)!;
        const reversed = median([...xs].reverse());
        const sorted = median([...xs].sort((a, b) => a - b));
        return m === reversed && m === sorted && m >= Math.min(...xs) && m <= Math.max(...xs);
      },
    ),
  );
});

test("median: does not mutate its input", () => {
  fc.assert(
    fc.property(fc.array(fc.integer()), (xs) => {
      const copy = [...xs];
      median(xs);
      assert.deepEqual(xs, copy);
    }),
  );
});

test("median: half the values are at or below it and half at or above", () => {
  fc.assert(
    fc.property(fc.array(fc.integer({ min: -1e6, max: 1e6 }), { minLength: 1 }), (xs) => {
      const m = median(xs)!;
      const below = xs.filter((x) => x <= m).length;
      const above = xs.filter((x) => x >= m).length;
      return below * 2 >= xs.length && above * 2 >= xs.length;
    }),
  );
});

test("wilson: no runs is no information, the full range", () => {
  assert.deepEqual(wilson(0, 0), { low: 0, high: 1 });
});

test("wilson: never returns NaN for any run count", () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 5000 }), (n) => {
      const { low, high } = wilson(0, n);
      return !Number.isNaN(low) && !Number.isNaN(high);
    }),
  );
});
