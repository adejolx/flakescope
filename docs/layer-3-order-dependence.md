# Layer 3: order dependence

**One line:** find tests that fail only because of the order tests run in, and
make that failure reproducible with a seed.

Files: [`src/order.ts`](../src/order.ts), the `order` command in [`src/cli.ts`](../src/cli.ts)

## Why this layer exists

The `order` fixture passes in file order every time, so Layers 1 and 2 call it
`clean`. It fails when the writer test runs before the reader test, because the
tests share a module-level variable. Normal runs never reveal that.

## The key idea: a seed

Vitest can shuffle test order. A **seed** is a number that fixes the shuffle:
same seed, same order, every time. So a failure at seed 3 can be reproduced
whenever you want.

```
pnpm exec vitest run fixtures/order.test.tsx --sequence.shuffle.tests --sequence.seed=3
```

## The pieces

| Name | What it does |
|---|---|
| `failedTestsForSeed(file, seed)` | One shuffled run of one file. Returns the failed test ids. |
| `scanSeeds(file, seeds)` | Tries each seed. Keeps only seeds where something failed. |
| `confirmSeed(file, seed, testId)` | Reruns one seed to decide: order-dependent or random. |

## How the `order` command works

1. Run the file with seeds 1 to 20, each shuffled (`scanSeeds`).
2. No seed produced a failure: print `no order dependence found in 20 seeds`.
3. Otherwise, for each test that failed, take the first seed that failed it.
4. Call `confirmSeed` on that seed and test (next section).
5. Print the verdict, the test name and the seed.

## `confirmSeed`: order or random?

A random flake also fails under shuffling, so a failing seed alone proves
nothing. The test: **rerun the same seed.**

- It passes even once: the seed does not decide the outcome. Verdict `random`.
  This is the cheap case, and it stops immediately.
- It fails again and again: keep going until `decide` says the fail rate is
  above 80%. That takes 16 fails in a row. Verdict `order-dependent`.

Why 16 and not 3? With 3 reruns, `timing` (about 65% fail rate) was mislabeled
`order-dependent` about 27% of the time. At 16 in a row, a random flake
doing that by luck is under 0.1%.

The cost: a real order dependence takes 16 reruns, about 25 seconds.

## Try it

```bash
node src/cli.ts order fixtures/order.test.tsx
```

Expected:

```
order-dependent  order: reader assumes empty cache  (seed 3, fails 16/16)
```

## Verified facts

- `reader` fails on seeds 3, 9, 11, 12, 14, 17, 18 and 20: 8 of 20 seeds.
- Seed 3 failed on every rerun, so the failure is reproducible.
- `timing` at seed 1 gave fail, pass, fail on three reruns. The seed does not
  explain a random flake. That difference is what `confirmSeed` uses.
- Vitest's JSON report lists tests in **file order, not execution order**.
  The tool cannot read the order from the report.

## Limits

- It shuffles tests **inside** a file. Pollution between files is not covered.
- It says which test fails and under which seed. It does **not** yet say which
  other test caused it (here: the writer). Finding that is Layer 3b.
- 20 seeds is enough for a two-test dependence (each seed has a 50% chance to
  put the writer first). A dependence that needs a specific order of several
  tests is rarer, and 20 seeds can miss it.
- It only inspects one file per command.

## Next: Layer 3b

Bisection to find the polluting test. Since the JSON report can't give the
order, 3b will run a victim together with a subset of the other tests across
several seeds, and narrow the subset by halves until one test remains.
