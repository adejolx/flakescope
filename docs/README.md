# flakescope docs

A Vitest-first CLI that finds flaky React tests and says why.

## Start here

1. [Decision graph](decision-graph.md): three diagrams showing what happens and why.
2. The layer docs, in order:

| Layer | Doc | Question it answers | Status |
|---|---|---|---|
| 1 | [Repeat runner](layer-1-repeat-runner.md) | What did one run produce? | done |
| 2 | [Stats and early stopping](layer-2-stats-and-early-stopping.md) | Is this test flaky, broken or clean, and how sure are we? | done |
| 3 | [Order dependence](layer-3-order-dependence.md) | Does it only fail in some orders? | done (3a) |
| 3b | [Find the polluter](layer-3b-find-the-polluter.md) | Which other test pollutes it? | done |
| 4 | not written | What happens under timers, CPU load, a fixed random seed? | planned |
| 5 | not written | What is the likely cause? | planned |
| 6 | not written | Reports for people and for coding agents | planned |

## Commands

```bash
node src/cli.ts                              # repeat the suite, stop early per test
node src/cli.ts 50                           # same, at most 50 runs
node src/cli.ts order fixtures/order.test.tsx   # look for order dependence in one file
```

Run them from the repo root. From another folder Vitest finds no config and
reports zero tests.

## Files

| File | Role |
|---|---|
| `src/run.ts` | Layer 1 and the `runMany` loop of Layer 2 |
| `src/stats.ts` | `wilson` and `decide` (Layer 2) |
| `src/order.ts` | Seed scanning and confirmation (Layer 3) |
| `src/cli.ts` | The only file that does work when started. Everything else only defines functions. |
| `fixtures/` | Four deliberately flaky tests, the tool's test bench |

## The fixtures

| File | Kind | How it flakes |
|---|---|---|
| `stable.test.tsx` | none | control, must never fail |
| `timing.test.tsx` | timing | random delay against a fixed sleep |
| `order.test.tsx` | order | module state leaks, fails only when shuffled |
| `random.test.tsx` | randomness | unseeded `Math.random`, about 10% fail |

The tool is right when it labels all four correctly.

## Code style rule

Plain loops, named helpers, comments that say why. No clever one-liners.
