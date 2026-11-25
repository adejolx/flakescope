import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

const SETUP = new URL("./probes/random-setup.ts", import.meta.url).href;
let load = 0;

async function sequence(seed: string | undefined, n: number): Promise<number[]> {
  const original = Math.random;
  const previous = process.env.FLAKESCOPE_RANDOM_SEED;
  try {
    if (seed === undefined) delete process.env.FLAKESCOPE_RANDOM_SEED;
    else process.env.FLAKESCOPE_RANDOM_SEED = seed;
    await import(`${SETUP}?load=${load++}`);
    return Array.from({ length: n }, () => Math.random());
  } finally {
    Math.random = original;
    if (previous === undefined) delete process.env.FLAKESCOPE_RANDOM_SEED;
    else process.env.FLAKESCOPE_RANDOM_SEED = previous;
  }
}

test("seeded Math.random: the same seed gives the same numbers", async () => {
  await fc.assert(
    fc.asyncProperty(fc.nat({ max: 0xffffffff }), async (seed) => {
      assert.deepEqual(await sequence(String(seed), 20), await sequence(String(seed), 20));
    }),
    { numRuns: 25 },
  );
});

test("seeded Math.random: every value is in [0, 1)", async () => {
  await fc.assert(
    fc.asyncProperty(fc.nat({ max: 0xffffffff }), async (seed) => {
      for (const x of await sequence(String(seed), 200)) assert.ok(x >= 0 && x < 1);
    }),
    { numRuns: 25 },
  );
});

test("seeded Math.random: different seeds give different sequences", async () => {
  await fc.assert(
    fc.asyncProperty(fc.nat({ max: 0xfffffffe }), async (seed) => {
      assert.notDeepEqual(await sequence(String(seed), 8), await sequence(String(seed + 1), 8));
    }),
    { numRuns: 25 },
  );
});

test("no seed set: Math.random is left alone", async () => {
  const original = Math.random;
  const seen = await (async () => {
    delete process.env.FLAKESCOPE_RANDOM_SEED;
    await import(`${SETUP}?load=${load++}`);
    return Math.random;
  })();
  assert.equal(seen, original);
});

test("seeded Math.random: any two distinct valid seeds give different sequences", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.nat({ max: 0xffffffff }),
      fc.nat({ max: 0xffffffff }),
      async (a, b) => {
        fc.pre(a !== b);
        assert.notDeepEqual(await sequence(String(a), 8), await sequence(String(b), 8));
      },
    ),
    { examples: [[0, 1], [0, 0xffffffff]] },
  );
});

test("seeded Math.random: a seed outside [0, 2^32) or not an integer is rejected", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.oneof(
        fc.integer({ min: 2 ** 32, max: Number.MAX_SAFE_INTEGER }).map(String),
        fc.stringMatching(/^[a-z.\-]{1,6}$/),
        fc.constant(""),
      ),
      async (bad) => {
        await assert.rejects(sequence(bad, 1), RangeError);
      },
    ),
    { examples: [["4294967296"], ["-1"], ["1.5"], ["abc"], [""]] },
  );
});
