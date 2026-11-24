// Setup file for the random-seed probe: with FLAKESCOPE_RANDOM_SEED set,
// Math.random becomes a seeded generator (same seed, same numbers).

const seed = process.env.FLAKESCOPE_RANDOM_SEED;

if (seed !== undefined) {
  let state = Number(seed) >>> 0;

  // mulberry32
  Math.random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
