# Guide 4: perturbation probes (read this, then read `src/perturb.ts`)

Goal: Layers 1-3 say THAT a test flakes. This layer says WHAT it reacts to.

## The idea in 3 lines

1. Change exactly ONE thing about how the test runs.
2. If the flake changes, that thing is a cause.
3. If nothing changes, rule that thing out.

This is the same trick as Layer 3 (shuffle order with a seed), applied to
other things.

## Run it

    node src/cli.ts probe fixtures/load.test.tsx "load: renders a big list within its time budget"

Takes about 25 seconds per test.

## What it printed (verified)

| test | Math.random probe | CPU load probe |
|---|---|---|
| `random` | **drives it** (seed 4, 16/16) | no effect |
| `timing` | **drives it** (seed 1, 16/16) | no effect |
| `load` | not the cause | **driven by load** (alone 0/6, loaded 16/16) |
| `stable` | inconclusive (never failed) | no effect |

Read `timing` carefully. It looks like a timing bug, but the delay comes from
`Math.random()`. The probe found the real cause.

## Probe 1: fix Math.random

- `src/probes/random-setup.ts` replaces `Math.random` with a seeded generator
  when the env var `FLAKESCOPE_RANDOM_SEED` is set. Same seed, same numbers.
- Vitest runs a "setup file" before each test file. That is how we change
  `Math.random` without editing any test.
- A setup file lives in the config, and there is no command line flag for it.
  So `writeRandomConfig` writes `.flakescope/random.config.ts`: the project's
  own config plus our setup file (`mergeConfig`).
- Then it reuses Layer 3 as is. `scanSeeds` and `confirmSeed` now take a
  `SeedRunner`: "run this file with this seed, return the failed ids".
  Layer 3 passes one that shuffles order. This layer passes one that fixes
  Math.random. Same code, different thing being fixed.
- "Fails 16 times in a row under one seed" means the seed decides the result,
  so Math.random is the cause.

## Probe 2: CPU load

- Baseline: run the file alone 6 times, one at a time.
- Load: run 8 copies at the same time, twice. They compete for the CPU. That
  is what happens in CI.
- Compare the two fail-rate ranges with `wilson` from Layer 2.
  Loaded range completely above the baseline range = load-sensitive.
  (`load`: baseline 0%..39%, loaded 81%..100%. No overlap.)

## New fixture

`fixtures/load.test.tsx` renders 3000 rows and expects it to take under
200 ms. Alone it takes ~120 ms and passes. With 8 copies at once it takes
~340 ms and fails. Plain `node src/cli.ts` calls it `clean` (16/16 passes in
the normal suite): the same kind of blind spot `order` had.

## Known limits

- **Parallel scanning leaks load.** The seed scan runs 4 copies at once. For
  the `load` test that made it fail in the scan, and the rerun then passed,
  so the tool said "not the cause". Correct here, but only because the
  confirm step caught it. A timing-sensitive test and a parallel scan don't mix.
- **Rare flakes are inconclusive.** A test that fails 1 time in 50 may never
  fail under 16 seeds. The tool says "inconclusive", not "no".
- The load probe uses 8 copies because this machine has 8 cores.
- `vitest.config.ts` must be in the project root (hardcoded for now).

## Exercise (do this one yourself)

Add a third probe in `perturb.ts`: **retries**. Vitest has a `--retry=N` flag.
A test that fails, then passes on retry, is flaky by definition. Write
`retryProbe(file, testId)`: run once with `--retry=3` and report whether the
test needed a retry. Hint: the JSON reporter's `assertionResults` entries
have a `retryCount`... check the real field name by reading `out.json`.
