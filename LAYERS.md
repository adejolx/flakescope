# flakescope: build log

Goal: a Vitest-first CLI that diagnoses *why* a React test is flaky, and emits
evidence an agent can act on.

## Fixtures (already built, don't edit)

| file | flake kind | how it flakes |
|---|---|---|
| `fixtures/stable.test.tsx` | none | control; must never fail |
| `fixtures/timing.test.tsx` | async/timing | random delay vs fixed sleep |
| `fixtures/order.test.tsx` | order dependence | leaked module state, fails only when shuffled |
| `fixtures/random.test.tsx` | randomness | unseeded `Math.random`, ~10% fail |

Your tool is "done" when it labels each of these correctly and calls `stable` clean.

## Layer 1: repeat runner  (YOU build this, in `src/run.ts`)

**Contract:** `runOnce(args): Promise<RunResult>` runs Vitest once and returns
per-test pass/fail. Then `runMany(n)` calls it n times.

**Follow [GUIDE-1.md](GUIDE-1.md): it has the step-by-step instructions and exact APIs.**
The clues below are the short version.

**Clues (anchors, not answers):**
1. Don't parse terminal text. Vitest has a machine-readable reporter. Find it:
   `pnpm exec vitest run --help`, look at `--reporter` and `--outputFile`.
2. Spawn Vitest as a child process with `node:child_process`. Which function
   gives you the exit code *and* lets you await completion?
3. A test result needs an identity. File path + full test name is the key.
   Why is a bare test name not enough?
4. A failing run exits non-zero. Is a non-zero exit always "a test failed"?
   (Think: config error, crash.) Your `RunResult` should distinguish these.

**Done when:** `runMany(20)` over the fixtures prints, per test, `passes/20`.
Expected: stable 20/20, random around 18/20, timing and order lower or higher
depending on config. Notice that `order` shows 20/20 *without* shuffle. That
gap is the lesson for Layer 3.

**Check before moving on:** why does a flake rate of 5/20 not prove the true
rate is 25%? (Layer 2 depends on your answer.)

## Upcoming layers (don't start)

2. Stats and early stopping  3. Order bisection  4. Perturbation probes
5. Cause classifiers  6. Agent and human reports
