# Guide 3: order dependence (shuffle + seeds)

Goal: catch tests like `order`, which pass in file order and fail only when
the tests run in a different order. Layer 2 called `order` "clean". That was
wrong. This layer fixes it.

## The idea in 4 lines

1. Vitest can shuffle test order. A **seed** is a number that fixes the shuffle.
   Same seed means the same order every time.
2. Try seeds 1..20. Some seeds make a test fail.
3. Rerun a failing seed. If it fails **every time**, the order is the cause.
4. If the same seed gives mixed results, it's a random flake, not order.

## Step 0: see it by hand (no code, 3 minutes)

Run each line. The flags are `--sequence.shuffle.tests` (shuffle tests inside
each file) and `--sequence.seed=N` (fix the shuffle).

    pnpm exec vitest run fixtures/order.test.tsx --sequence.shuffle.tests --sequence.seed=3
    pnpm exec vitest run fixtures/order.test.tsx --sequence.shuffle.tests --sequence.seed=3
    pnpm exec vitest run fixtures/order.test.tsx --sequence.shuffle.tests --sequence.seed=4

Verified results:
- seed 3: `reader` fails, **every time** you run it
- seed 4: everything passes

Across seeds 1..20, `reader` fails on exactly these seeds:
**3, 9, 11, 12, 14, 17, 18, 20** (8 of 20). Keep this list for checkpoints.

Now the contrast. Run `timing` with the same seed 3 times:

    pnpm exec vitest run fixtures/timing.test.tsx --sequence.shuffle.tests --sequence.seed=1

Verified: seed 1 gave `fail, pass, fail` on three runs. Same seed, different
result. So the seed does NOT explain the failure. That is the signature of a
random flake. This difference is how the tool tells the two apart.

## Step 1: split `run.ts` (it has a side-effect problem)

Right now the bottom of `run.ts` runs the CLI the moment the file is loaded.
If a new file does `import { runOnce } from "./run.ts"`, it would start a
100-run job by accident. Fix: files that other files import must contain only
definitions, no top-level work.

1. Create `src/cli.ts`.
2. Move everything from the line `// \`node src/run.ts 50\`` to the end of
   `run.ts` into `cli.ts`. That is: `maxRuns`, `pct`, the timing, the print
   loop and the cost report.
3. At the top of `cli.ts`: `import { runMany } from "./run.ts";`
4. From now on run the tool with: `node src/cli.ts`

Checkpoint: `node src/cli.ts 5` prints the same kind of table as before
(5 runs max). `node src/run.ts` now prints nothing and exits.

## Step 2: let `runOnce` take extra Vitest flags

Add a second parameter to `runOnce` in `run.ts`:

    export async function runOnce(
      files: string[] = [],
      extraArgs: string[] = [],
    ): Promise<RunResult>

Put `...extraArgs` into the `args` array, right before `...files`.

Checkpoint: `node src/cli.ts 3` still works.

## Step 3: `scanSeeds` (new file `src/order.ts`)

    export async function scanSeeds(
      file: string,
      seeds: number[],
    ): Promise<Map<number, string[]>>

For each seed, call:

    runOnce([file], ["--sequence.shuffle.tests", `--sequence.seed=${seed}`])

- Same crash handling as `runMany`: a `crash` throws an `Error`.
- Return `seed -> ids of tests that failed under that seed`.
- Only store seeds that had at least one failure.
- `file` is an absolute path. `const file = new URL("../fixtures/order.test.tsx", import.meta.url)`
  gives a URL. `fileURLToPath` from `node:url` turns it into a path.

Checkpoint: `scanSeeds(orderFile, [1..20])` (build the array with
`Array.from({ length: 20 }, (_, i) => i + 1)`) should return exactly the
seeds from step 0: 3, 9, 11, 12, 14, 17, 18, 20, each with `reader`.
Takes about 30 seconds.

## Step 4: `confirmSeed`: order or random?

    export async function confirmSeed(
      file: string,
      seed: number,
      id: string,
      reruns = 3,
    ): Promise<"order-dependent" | "random">

Run that seed `reruns` times. Count how often test `id` failed.
- Failed every time -> `"order-dependent"`
- Anything else -> `"random"`

Checkpoint:
- `confirmSeed(orderFile, 3, readerId)` -> `order-dependent`
- `confirmSeed(timingFile, 1, timingId)` -> `random` most of the time.
  It can say `order-dependent` by luck: the chance of 3 fails in a row is
  about 27%. That is the same trap as the `broken` rule. Note it for later.

## Step 5: a CLI command

In `cli.ts`: if `process.argv[2] === "order"`, take the file path from
`process.argv[3]`, run `scanSeeds` on seeds 1..20, then `confirmSeed` on the
first failing seed for each failed test, and print:

    order-dependent  order: reader assumes empty cache  (seed 3, fails 3/3)

and for a file with no failing seed:

    no order dependence found in 20 seeds

Run: `node src/cli.ts order fixtures/order.test.tsx`

## Layer 3b (next guide, don't start)

Knowing `reader` fails under seed 3 is not enough. The agent needs to know
**which other test pollutes it** (here: `writer`). We find it by bisection.
Vitest's JSON output does not tell us execution order (verified: it always
lists tests in file order), so 3b uses a different trick.

## Done when

`node src/cli.ts order fixtures/order.test.tsx` reports `reader` as
order-dependent with a reproducible seed. Paste `src/order.ts` and `cli.ts`.
