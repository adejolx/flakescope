// Vitest setup file used by the random-seed probe.
// When FLAKESCOPE_RANDOM_SEED is set, Math.random becomes a seeded generator:
// the same seed gives the same sequence of numbers on every run.
// If a flaky test becomes predictable under a fixed seed, Math.random was
// the cause.

const seed = process.env.FLAKESCOPE_RANDOM_SEED;

if (seed !== undefined) {
  let state = Number(seed) >>> 0;

  // mulberry32: a tiny, well-known seeded random number generator.
  Math.random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
