# Guide 5: from evidence to a diagnosis

Goal: one command that runs everything and prints the likely cause.

    node src/cli.ts diagnose fixtures/load.test.tsx "load: renders a big list within its time budget"

## The big idea: gather, then judge

Two jobs, two files:

| job | file | speed | touches the disk? |
|---|---|---|---|
| **gather** evidence (runs Vitest many times) | `src/diagnose.ts` | minutes | yes |
| **judge** the evidence (apply rules) | `src/classify.ts` | milliseconds | no |

Why split them? You can test the judging without running Vitest. The tests
in `src/classify.test.ts` hand-build evidence and run in 160 ms:

    node --test src/classify.test.ts

`node:test` is built into Node. No extra package.

## What `diagnose` gathers

1. **Repeat** (Layer 2) on the test's file: clean, flaky or broken?
2. **Order** (Layer 3): fails every time under one shuffle seed? Who pollutes?
3. **Math.random** (Layer 4): fails every time under one fixed seed?
4. **CPU load** (Layer 4): fail rate alone vs under load.

It runs them one after another, not in parallel. Parallel probes add CPU
load and disturb each other.

## The rules in `classify()` (first match wins, top to bottom)

1. Never passes -> `deterministic-failure`. Stop. Not a flake.
2. Fails every time under one shuffle seed -> `order-dependence`
3. Fails every time under one Math.random seed -> `math-random`
4. Fail rate jumps under load -> `cpu-load`
5. Flaky but 2, 3, 4 all say no -> `unknown`, low confidence
6. Otherwise -> `none`

Rules 2, 3 and 4 can all fire. They are reported together, high confidence first.

## One rule that is easy to miss

The order scan and the Math.random scan run 4 copies of Vitest at once.
That adds CPU load. If rule 4 fires, rules 2 and 3 drop to **medium**
confidence, with a note. Evidence gathered under load can be caused by the
load. This is the Layer 4 limit, turned into logic.

## Reading a result

    CPU-LOAD  (high confidence)
      - fail rate 0%..39% alone, 81%..100% under load
      fix: The test depends on how fast the machine is. ...

- `because` lines are the evidence. They are what an agent will quote.
- `fix` is the next action.

## Exercise (do this one yourself)

Open `src/classify.test.ts`. Add a test for this case: a test is
`order-dependent` with no polluters found (`polluters: []`). What should the
`because` text say? Run `node --test src/classify.test.ts` and see it pass
or fail. Then change a rule in `classify.ts` and watch which test catches it.
