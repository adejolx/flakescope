# Guide 2: stats and early stopping

Goal: stop running a test the moment you know enough. Never run a fixed 20.

## The 3 facts that make this cheap

1. **Flaky is cheap to prove.** Seeing one pass AND one fail proves the test
   is flaky. Done. No maths needed.
2. **Broken needs real evidence.** Not 3 fails in a row: a test that fails
   65% of the time does that about 27% of the time (this fooled the tool once).
   Use the range instead: 16 fails in a row puts the bottom of the fail-rate
   range above 80%. Then it is a real failure, not a flake.
3. **Clean is expensive to prove.** 0 fails in n runs only says the fail rate
   is *probably* below some number. That number shrinks slowly:

| runs with 0 fails | fail rate is probably below |
|---|---|
| 20 | 16% |
| 35 | 10% |
| 73 | 5% |

So the budget goes to proving "clean". You choose the threshold (default 10%
= 35 runs). The tool reports "0 fails in 35 runs, rate below 10%", never "stable".

## Step 1: types (src/stats.ts, new file)

    export type Verdict = "broken" | "flaky" | "clean" | "undecided";
    export type Interval = { low: number; high: number };

Checkpoint: `node src/stats.ts` runs with no errors.

## Step 2: `wilson(fails, n)`: the guess range

Signature: `export function wilson(fails: number, n: number, z = 1.96): Interval`

This turns "5 fails in 20" into a range for the true fail rate.
Formula (write it as 4 lines):

    p      = fails / n
    denom  = 1 + z*z / n
    center = (p + z*z / (2*n)) / denom
    margin = z * Math.sqrt(p*(1-p)/n + z*z / (4*n*n)) / denom
    low    = center - margin     // clamp to at least 0
    high   = center + margin     // clamp to at most 1

`z = 1.96` means "95% sure". `Math.sqrt` is built in.

Checkpoint (verified numbers, 3 decimals):

    wilson(0, 20)   ->  0.000 .. 0.161
    wilson(5, 20)   ->  0.112 .. 0.469
    wilson(0, 73)   ->  0.000 .. 0.050
    wilson(10, 10)  ->  0.722 .. 1.000

Put these in a `console.log` at the bottom of the file, run
`node src/stats.ts`, compare.

## Step 3: `decide(passes, fails, opts)`: one verdict

    export function decide(
      passes: number,
      fails: number,
      opts: { cleanBelow: number; brokenAbove: number },
    ): Verdict

Rules, in this order (first match wins):

1. `passes > 0 && fails > 0` -> `"flaky"`
2. `passes === 0 && fails > 0 && wilson(fails, fails).low > opts.brokenAbove`
   -> `"broken"`
3. `fails === 0 && passes > 0 && wilson(0, passes).high < opts.cleanBelow`
   -> `"clean"`
4. otherwise -> `"undecided"`

Use `{ cleanBelow: 0.1, brokenAbove: 0.8 }` as the defaults.

Checkpoint (call `decide` with those defaults):

    decide(3, 0)   -> undecided     (too few runs to call it clean)
    decide(35, 0)  -> clean         (upper bound just under 10%)
    decide(8, 2)   -> flaky
    decide(0, 3)   -> undecided     (3 fails in a row proves nothing)
    decide(0, 15)  -> undecided
    decide(0, 16)  -> broken

Why rule 1 comes first: one pass plus one fail overrides everything else.

## Step 4: rewrite `runMany` to stop early

New return type, per test:

    export type TestSummary = {
      id: string;
      passes: number;
      fails: number;
      verdict: Verdict;
      failRate: Interval;   // wilson(fails, passes + fails)
    };

Change `runMany(n)` to `runMany(maxRuns: number): Promise<TestSummary[]>`.

Logic per loop iteration:
1. `runOnce()`, same crash and zero-tests checks as before.
2. Update each test's `passes` or `fails`. Ignore `"other"` (skipped).
3. Call `decide` for every test.
4. If **every** test's verdict is not `"undecided"`, `break`.
5. After the loop, build and return the summaries. Tests still `undecided`
   at `maxRuns` keep that verdict. That is honest: "needs more runs".

Data shape tip: use `Map<string, { passes: number; fails: number }>`.

Checkpoint: `maxRuns = 100`. Expected verdicts:

    stable   -> clean     (after ~35 runs, this sets total run count)
    random   -> flaky     (usually within 10 runs)
    timing   -> flaky     (within 2 or 3 runs)
    order x2 -> clean     (no shuffle yet; Layer 3 fixes the blind spot)

Print one line per test: `verdict  passes/total  rate low..high  id`.

## Step 5 (do after step 4 works): the big speed-up

The loop still re-runs ALL tests until the slowest one is decided. Once
`timing` is flaky, running it again wastes time. Fix: after each run, rerun
only tests that are still `undecided`.

**Measured on the fixtures (seconds per run):**

| command | time |
|---|---|
| all files | 1.9 |
| `-t "test name"` (filter by test name) | 1.7 |
| file path filter, 1 file | 1.4 |

Lesson: filter by **file path**, not test name. `-t` still loads every file
and only skips the test bodies. A file path skips the other files entirely.
The saving here is small because the fixture suite has only 4 tiny files.
On a real suite with hundreds of files, rerunning 1 file instead of all is
the difference between seconds and minutes.

By hand first:

    pnpm exec vitest run fixtures/timing.test.tsx fixtures/random.test.tsx

Only those 2 files run. Other files don't appear in the output.

Code change (small):
1. Give `runOnce` an optional argument: `files: string[] = []`.
2. Add `...files` to the end of the `args` array.
3. In `runMany`, before each run, compute the file paths of tests that are
   still `undecided`. The file path is the part of `id` before `::`
   (`id.split("::")[0]`). Use a `Set` to remove duplicates.
4. Pass those paths to `runOnce(files)`.
5. Tests that were already decided won't appear in later runs. Their counts
   freeze. That is correct.

Skip step 5 and the tool is still right. Step 5 only makes it cheaper.

Also add one number to the printout: total **test executions**
(sum of `passes + fails` over all tests). Fixed-35 would be 5 x 35 = 175.
Early stopping runs fewer, and this number shows it even when wall time
barely moves.

**Do NOT** try to rerun inside one Vitest process (its Node API). I tried:
state leaked between reruns and the `order` test failed on every run after
the first. A flake detector that creates its own flakes is useless.

## Done when

Stable gets `clean`, random and timing get `flaky`, and the whole thing takes
well under the ~32 s from Layer 1. Paste `src/stats.ts` and `src/run.ts`.
