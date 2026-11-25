import fc from "fast-check";
import type { Evidence } from "./classify.ts";

const interval = fc
  .tuple(fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }))
  .map(([a, b]) => ({ low: Math.min(a, b), high: Math.max(a, b) }));

const ms = fc.option(fc.integer({ min: 0, max: 10000 }), { nil: undefined });

export const evidence: fc.Arbitrary<Evidence> = fc.record({
  scanConcurrency: fc.integer({ min: 1, max: 8 }),
  repeat: fc.record({
    verdict: fc.constantFrom("broken", "flaky", "clean", "undecided"),
    passes: fc.nat({ max: 200 }),
    fails: fc.nat({ max: 200 }),
    failRate: interval,
    passMedianMs: ms,
    failMedianMs: ms,
  }),
  order: fc.oneof(
    fc.constant({ verdict: "not-order-dependent" as const }),
    fc.record({
      verdict: fc.constant("order-dependent" as const),
      seed: fc.integer({ min: 1, max: 100 }),
      polluters: fc.array(fc.string({ minLength: 1 }), { maxLength: 3 }),
    }),
  ),
  random: fc.oneof(
    fc.constantFrom({ verdict: "not-random-driven" as const }, { verdict: "inconclusive" as const }),
    fc.record({ verdict: fc.constant("random-driven" as const), seed: fc.integer({ min: 1, max: 100 }) }),
  ),
  load: fc.record({
    verdict: fc.constantFrom("load-sensitive", "no-load-effect"),
    alone: interval,
    loaded: interval,
  }),
});
