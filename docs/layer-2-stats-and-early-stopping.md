# Layer 2: statistics and early stopping

**One line:** stop running a test the moment the evidence is strong enough,
instead of always running a fixed number of times.

Files: [`src/stats.ts`](../src/stats.ts), `runMany` in [`src/run.ts`](../src/run.ts)

## Why this layer exists

Layer 1 gives counts like "5 failures in 20 runs". Those counts are noisy.
A test with a true 25% fail rate shows anywhere from 1 to 7 failures in 20 runs.
So the tool needs two things:

1. A way to say how sure it is.
2. A rule for when it knows enough to stop.

## The pieces

| Name | What it does |
|---|---|
| `wilson(fails, n)` | Turns "fails out of n" into a range for the true fail rate. |
| `decide(passes, fails)` | Returns one verdict for one test. |
| `runMany(maxRuns)` | Repeats the suite, tallies, stops early. Returns `TestSummary[]`. |

## `wilson`: the guess range

```
wilson(5, 20)  ->  0.112 .. 0.469
```

Read it as: "5 fails in 20 runs. The true fail rate is probably between 11% and
47%." More runs make the range narrower. You can treat the formula as a black
box. The input and output are what matter.

## `decide`: four rules, first match wins

| # | Rule | Verdict | Cost to reach it |
|---|---|---|---|
| 1 | Seen at least one pass and one fail | `flaky` | 2 runs at best |
| 2 | Zero passes, and the low end of the fail range is above 80% | `broken` | 16 fails in a row |
| 3 | Zero fails, and the high end of the fail range is below 10% | `clean` | 35 passes in a row |
| 4 | Anything else | `undecided` | run again |

Defaults: `cleanBelow = 0.1`, `brokenAbove = 0.8`.

**Flaky is cheap to prove. Clean and broken are expensive.** One pass and one
fail proves a test is flaky. Proving a test is stable needs many passes.

| Runs with zero fails | The fail rate is probably below |
|---|---|
| 20 | 16% |
| 35 | 10% |
| 73 | 5% |

So the tool never says "stable". It says "0 fails in 35 runs, rate below 10%".

### A bug this caught

The first version called a test `broken` after 3 fails in a row. A test that
fails 65% of the time does that about 27% of the time, and `timing` was
mislabeled. The rule now needs the range, not a streak. `decide(0, 3)` returns
`undecided`.

## `runMany`: the loop

1. `runOnce`, then `unwrap` (throws on a crash or an empty run).
2. Add one to the pass or fail count of each test. Skipped tests count as neither.
3. Call `decide` for every test.
4. Collect the files that still hold an `undecided` test.
5. None left: stop. Otherwise rerun **only those files** and go to step 1.
6. Stop anyway at `maxRuns`. Tests still `undecided` stay `undecided`.

Filtering by file path matters. Filtering by test name (`-t`) still loads every
file. Measured: all files 1.9 s, `-t` 1.7 s, one file path 1.4 s.

## Try it

```bash
node src/cli.ts          # up to 100 runs
node src/cli.ts 50       # up to 50 runs
```

## Verified result

```
clean     35/35  fail rate 0%..10%   order (both tests)
flaky     2/3    fail rate 6%..79%   random   (decided after 3 runs)
clean     35/35  fail rate 0%..10%   stable
flaky     2/3    fail rate 6%..79%   timing   (decided after 3 runs)

35 runs, 111 test executions (fixed would be 175), 53.3s
```

The `random` and `timing` rows stop counting once they are decided, so their
totals are small and differ from run to run. The 111 executions was the same
in two separate runs.

That is about 37% fewer test executions than a fixed 35. Wall time fell less
(57 s to about 50 s): most of each run is fixed startup cost, and this suite
has only 4 tiny files. On a suite with hundreds of files, rerunning one file instead of all
would save far more.

## Things we tried and rejected

- **Rerunning inside one Vitest process** (its Node API). Faster per run, but
  state leaked between reruns and the `order` test failed on every run after
  the first. A flake detector that creates flakes is useless.

## Limits

- `clean` at a 10% threshold still allows a 9% flake. Tighten `cleanBelow` and
  the cost rises quickly (5% needs 73 runs).
- `order` is reported `clean`. It only fails when tests run in another order.
  Layer 3 finds that.
