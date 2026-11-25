import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { scanSeeds, confirmSeed } from "./order.ts";

const failingSeeds = fc.uniqueArray(fc.integer({ min: 1, max: 60 }), { maxLength: 30 });

test("scanSeeds: reports exactly the seeds whose run failed something, with those ids", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.uniqueArray(fc.integer({ min: 1, max: 60 }), { minLength: 1, maxLength: 30 }),
      failingSeeds,
      fc.integer({ min: 1, max: 8 }),
      async (seeds, failing, concurrency) => {
        const bad = new Set(failing);
        const out = await scanSeeds(
          "f",
          seeds,
          async (_f, seed) => (bad.has(seed) ? [`t${seed}`] : []),
          undefined,
          concurrency,
        );
        const expected = new Map(seeds.filter((s) => bad.has(s)).map((s) => [s, [`t${s}`]]));
        assert.deepEqual(out, expected);
      },
    ),
  );
});

test("scanSeeds: with stopWhenFailed, never reports more than a plain scan and always includes a seed that fails the target", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.uniqueArray(fc.integer({ min: 1, max: 60 }), { minLength: 1, maxLength: 30 }),
      failingSeeds,
      fc.integer({ min: 1, max: 8 }),
      async (seeds, failing, concurrency) => {
        const bad = new Set(failing);
        const run = async (_f: string, seed: number) => (bad.has(seed) ? ["target"] : []);
        const full = await scanSeeds("f", seeds, run, undefined, concurrency);
        const early = await scanSeeds("f", seeds, run, "target", concurrency);
        for (const seed of early.keys()) assert.ok(full.has(seed));
        assert.equal(early.size > 0, full.size > 0);
      },
    ),
  );
});

test("scanSeeds: no seeds means no failures", async () => {
  assert.deepEqual(await scanSeeds("f", [], async () => ["x"]), new Map());
});

const countingRunner = (failFirst: number) => {
  let calls = 0;
  return async () => (calls++ < failFirst ? ["victim"] : []);
};

test("confirmSeed: a pass after k fails is random and reports k failures", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 0, max: 15 }),
      fc.integer({ min: 1, max: 6 }),
      async (k, concurrency) => {
        const r = await confirmSeed("f", 1, "victim", countingRunner(k), concurrency);
        assert.equal(r.verdict, "random");
        assert.equal(r.failures, k);
        assert.equal(r.reruns, k + 1);
      },
    ),
  );
});

test("confirmSeed: failing every time is order-dependent with at least 16 failures", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 1, max: 6 }), async (concurrency) => {
      const r = await confirmSeed("f", 1, "victim", async () => ["victim"], concurrency);
      assert.equal(r.verdict, "order-dependent");
      assert.ok(r.failures >= 16);
      assert.equal(r.failures, r.reruns);
    }),
  );
});

test("confirmSeed: failures of other tests do not confirm the victim", async () => {
  const r = await confirmSeed("f", 1, "victim", async () => ["someone-else"]);
  assert.equal(r.verdict, "random");
  assert.equal(r.failures, 0);
});

const badConcurrency = fc.oneof(
  fc.integer({ max: 0 }),
  fc.double({ noInteger: true, noNaN: true }),
  fc.constant(NaN),
);

test("scanSeeds: a concurrency that is not a positive integer is rejected, not looped on", async () => {
  await fc.assert(
    fc.asyncProperty(badConcurrency, async (c) => {
      await assert.rejects(scanSeeds("f", [1, 2, 3], async () => [], undefined, c), RangeError);
    }),
    { examples: [[0], [-1], [1.5], [NaN]] },
  );
});

test("confirmSeed: a concurrency that is not a positive integer is rejected, not looped on", async () => {
  await fc.assert(
    fc.asyncProperty(badConcurrency, async (c) => {
      await assert.rejects(confirmSeed("f", 1, "v", async () => [], c), RangeError);
    }),
    { examples: [[0], [-1], [1.5], [NaN]] },
  );
});
