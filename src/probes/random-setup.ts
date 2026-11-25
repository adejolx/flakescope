/**
 * Setup file for the random-seed probe. When FLAKESCOPE_RANDOM_SEED is set,
 * Math.random becomes a seeded mulberry32 generator: equal seeds give equal
 * sequences of numbers in [0, 1) and distinct seeds give distinct sequences.
 * The generator has a 32-bit state, so a seed must be an integer in [0, 2^32);
 * anything else throws instead of silently wrapping onto another seed.
 */
const seed = process.env.FLAKESCOPE_RANDOM_SEED;

if (seed !== undefined) {
  if (!/^\d+$/.test(seed) || Number(seed) > 0xffffffff) {
    throw new RangeError(
      `FLAKESCOPE_RANDOM_SEED must be an integer in [0, 2^32), got "${seed}"`,
    );
  }
  let state = Number(seed);

  Math.random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
