# flakescope

Finds out **why** a React test is flaky, and hands a coding agent a command
that reproduces it.

Built for Vitest + React Testing Library. Plain Node and TypeScript, no
runtime dependencies beyond Vitest itself.

```bash
$ node src/cli.ts diagnose fixtures/order.test.tsx "order: reader assumes empty cache"

test:      order: reader assumes empty cache
file:      fixtures/order.test.tsx
observed:  clean, 0 fails in 36 runs (fail rate 0%..10%)

ORDER-DEPENDENCE  (high confidence)
  evidence:
    - fails every time under shuffle seed 3
    - polluted by: order: writer populates cache
  fix: Shared state leaks between tests. Reset it in a beforeEach/afterEach, ...
  reproduce: pnpm exec vitest run fixtures/order.test.tsx --sequence.shuffle.tests --sequence.seed=3
```

Note the `observed: clean` line. A normal run never fails this test. Only a
shuffled order does. That is the kind of flake that survives a "just rerun it"
approach.

## Why

Detecting a flaky test is easy: rerun it. **Diagnosing** it is the slow part,
and that is where an engineer (or an agent) loses the afternoon. flakescope
changes one thing about how the test runs, watches whether the flake reacts,
and reports the cause with the evidence and a reproduction command.

## Quick start

Needs Node 24+ and pnpm.

```bash
pnpm install
node src/cli.ts                    # repeat the whole suite, stop early per test
node src/cli.ts order <file>       # look for order dependence in one file
node src/cli.ts probe <file> "<test name>"      # fix Math.random / add CPU load
node src/cli.ts diagnose <file> "<test name>"   # everything, ranked causes
node src/cli.ts diagnose <file> "<test name>" --json   # for agents and CI
```

Run from the repo root. `diagnose` exits `1` when it finds a problem and `0`
when it does not, so a CI job can act on it.

## How it works

| Layer | Question | Technique |
|---|---|---|
| 1 | What did one run produce? | Run Vitest as a child process, read its JSON report. A missing report means a crash, not a test failure. |
| 2 | Flaky, broken or clean, and how sure? | Wilson score interval on the fail rate. Stop each test as soon as it is decided: one pass plus one fail proves "flaky". |
| 3 | Does it only fail in some orders? | Shuffle with fixed seeds, rerun a failing seed until it fails 16 times in a row. Then bisect to find the test that pollutes it. |
| 4 | What does it react to? | Fix `Math.random` with a seeded generator. Run 8 copies at once and compare the fail-rate ranges alone vs under load. |
| 5 | What is the likely cause? | `classify()`: pure rules over the gathered evidence, instant to run and unit tested. |
| 6 | Who reads the result? | One `Report` object, printed as text for people and JSON for agents. |

`diagnose.ts` gathers evidence (slow, runs Vitest). `classify.ts` and
`report.ts` judge it (instant, no I/O). That split is why 13 unit tests run in
under 200 ms.

## Results on the fixtures

`fixtures/` holds deliberately flaky tests. Each diagnosis below is the real
output of `diagnose` on an 8-core machine.

| Fixture | Flake | Diagnosis | Time |
|---|---|---|---|
| `order` | state leaks, fails only when shuffled | order dependence, polluter named | 48 s |
| `pollution` | 1 polluter hidden among 7 tests | order dependence, polluter named | 71 s |
| `random` | unseeded `Math.random`, ~10% fail | `Math.random` | 24 s |
| `timing` | random delay vs a fixed sleep | `Math.random` (not timing) | 27 s |
| `load` | 200 ms render budget | CPU load: 0-10% alone, 81-100% loaded | 44 s |
| `stable` | none | no flake observed | 53 s |

`timing` looks like a timing bug. The probe shows its delay comes from
`Math.random`.

## Measured decisions

Numbers, not guesses. Where a speed-up was tried and dropped, that is listed.

- **Early stopping.** Per-test stopping runs 410 test executions where a fixed
  36 runs would run 504, on the whole fixture suite.
- **Parallel runs.** Rendering a 3000-row list takes 130 ms alone, 137 ms with
  2 copies running, 174 ms with 4 (max 238 ms, over the 200 ms budget).
  Baseline repeat runs use 2 at a time. Seed scans use 4, because order
  failures depend on the seed, not on timing. Scans cut the order check from
  about 98 s to 44 s.
- **Cleaning up.** Each run writes a temp folder. Before the fix, one session
  left 2,606 of them.
- **Tried and dropped: rerunning inside one Vitest process.** State leaked
  between reruns, so the `order` test failed on every run after the first. A
  flake detector that creates flakes is not usable.
- **Tried and dropped: skipping `pnpm exec`.** Saves about 0.06 s per run.
- **A rule that was wrong, and the fix.** The first `broken` rule was "3 fails
  in a row". It labeled `timing` (a 65% flake) as broken. A test that fails
  65% of the time does that 27% of the time. The rule now needs the fail-rate
  range to sit above 80%, which takes 16 straight fails.

## Limits

- One probe can miss a real polluter, about 0.4% of the time.
- Rare flakes (about 1 in 50) may never fail under the probe seeds. The
  result is "inconclusive", not "no".
- Order bisection works inside one file. Pollution across files needs a
  different method.
- The seed scans run copies in parallel, which adds CPU load. For a
  load-sensitive test, the order and `Math.random` findings are reported at
  medium confidence for that reason.
- `vitest.config.ts` must be in the repo root.
- Proving a test "clean" at a 10% threshold costs about 36 runs. That cost
  cannot be cut without weakening the claim.

## CI sketch

Not run on GitLab yet. It shows the intended use:

```yaml
flaky-diagnosis:
  stage: test
  when: manual
  variables:
    TEST_FILE: ""
    TEST_NAME: ""
  script:
    - pnpm install --frozen-lockfile
    - node src/cli.ts diagnose "$TEST_FILE" "$TEST_NAME" --json > flakescope.json || true
  artifacts:
    paths: [flakescope.json]
```

## Development

```bash
pnpm test           # unit tests for classify() and report()
pnpm typecheck      # tsc over src/ and fixtures/
pnpm fixtures       # run the flaky fixtures (some are meant to fail)
```

More: [docs/decision-graph.md](docs/decision-graph.md) shows the decision flow.
