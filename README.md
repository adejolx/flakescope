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
  reproduce: npx vitest run fixtures/order.test.tsx --sequence.shuffle.tests --sequence.seed=3
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

**On another project:** run it from that project's root, after its
dependencies are installed:

```bash
cd ~/some-react-project
node /path/to/flakescope/src/cli.ts diagnose path/to/File.test.tsx "full test name"
```

It runs the project's own Vitest (`node_modules/vitest`) and extends its
`vitest.config.*` or `vite.config.*`. It writes a `.flakescope/` folder into
the project; add it to that project's `.gitignore`.

## How it works

| Layer | Question | Technique |
|---|---|---|
| 1 | What did one run produce? | Run Vitest as a child process, read its JSON report. A missing report means a crash, not a test failure. |
| 2 | Flaky, broken or clean, and how sure? | Wilson score interval on the fail rate. Stop each test as soon as it is decided: one pass plus one fail proves "flaky". |
| 3 | Does it only fail in some orders? | Shuffle with fixed seeds, rerun a failing seed until it fails 16 times in a row. Then bisect to find the test that pollutes it. |
| 4 | What does it react to? | Fix `Math.random` with a seeded generator. Run 8 copies at once and compare the fail-rate ranges alone vs under load. |
| 5 | What is the likely cause? | `classify()`: pure rules over the gathered evidence, instant to run and unit tested. It also reads test durations: failing runs that take 4x+ longer than passing runs mean a wait is timing out. |
| 6 | Who reads the result? | One `Report` object, printed as text for people and JSON for agents. |

`diagnose.ts` gathers evidence (slow, runs Vitest). `classify.ts` and
`report.ts` judge it (instant, no I/O). That split is why 19 unit tests run in
under 200 ms.

## Results on the fixtures

`fixtures/` holds deliberately flaky tests. Each diagnosis below is the real
output of `diagnose` on an 8-core machine.

| Fixture | Flake | Diagnosis | Time |
|---|---|---|---|
| `order` | state leaks, fails only when shuffled | order dependence, polluter named | 48-51 s |
| `pollution` | 1 polluter hidden among 7 tests | order dependence, polluter named | 71 s* |
| `random` | unseeded `Math.random`, ~10% fail | `Math.random` | 26-28 s |
| `timing` | random delay vs a fixed sleep | `Math.random` (not timing) | 27 s |
| `load` | 200 ms render budget | CPU load: 0-10% alone, 81-100% loaded | 60-84 s |
| `lostevent` | an update that sometimes never arrives | wait timeout (medium: only 1 failure seen) | 25 s |
| `stable` | none | no flake observed | 49-52 s |

\* timed before the last round of changes.

`timing` looks like a timing bug. The probe shows its delay comes from
`Math.random`.

## Check on a real project: intercode

The fixtures are tests I wrote, so they prove little. I also ran the tool on
[intercode](https://github.com/neinteractiveliterature/intercode) (React 19,
Vitest, jsdom), at the commit before the fix for its
[issue #12222](https://github.com/neinteractiveliterature/intercode/issues/12222):
`EventList.test.tsx`, test "sorting asks again in the chosen order".

- **First attempt: UNKNOWN.** The tool found it flaky (3 fails in 36 runs),
  not order-dependent, not `Math.random`, no CPU-load effect. It named no
  cause, which was honest.
- **The raw data had a clue the tool threw away:** passing runs took 170-225 ms,
  failing runs 1,226-1,242 ms. That is two clusters, not a gradual slowdown. The
  test's `waitFor` has a 1,000 ms limit, so the failing runs are waits that
  timed out.
- **After adding duration evidence:** `WAIT-TIMEOUT`, high confidence: 9 fails
  in 36 runs (14%..41%), failing runs about 1,229 ms against 189 ms passing.
- **Load does not explain it.** The maintainers' guess in the issue was CPU
  load, marked "not verified". At 4, 8 and 16 copies at once the test failed
  0 of 48 times. At 1 and 2 at once it failed in 2 to 8 of every 12 runs.
- **Their fix, a 5,000 ms timeout, did not remove the flake.** At the fix
  commit, 2 of 24 runs of that test still failed, at about 5,250 ms.

Caveats: one machine, small samples (2 failures at the fix commit), and the
failure rate varied a lot between my batches (from 3 of 36 to 8 of 12). The
claim is "the awaited update sometimes never arrives", not a proven root
cause. I have not posted anything to the project.

Running it on a real project also found two bugs the fixtures could not:
the `Math.random` probe's setup file lived outside the project and Vite
refused to serve it, and the tool assumed pnpm and a root `vitest.config.ts`.
Both are fixed.

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
- **A false finding, and the fix.** The seed scans run 4 copies at once. For a
  load-sensitive test, that load alone made it fail 16 times in a row under
  one seed, so the `load` fixture also got a false `Math.random` finding.
  `diagnose` now runs the load check first and, for a load-sensitive test,
  reruns those scans one copy at a time. 4 of 4 reruns on `load` then gave
  only CPU load.
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
- The seed scans run 4 copies at once. Tests found to be load-sensitive are
  rescanned one at a time; other tests keep the faster scan.
- The `wait-timeout` rule is a heuristic: failing runs at least 4x slower than
  passing runs, and at least 200 ms slower. With fewer than 3 failures it
  reports medium confidence.
- Run it from the project root. Needs `node_modules/vitest` (so not yarn
  Plug'n'Play) and a `vitest.config.*` or `vite.config.*` in that folder.
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
