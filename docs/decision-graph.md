# Decision graph: what the tool does and why

Three diagrams, from the whole tool down to the details. Mermaid renders in
GitHub and in most Markdown viewers.

## 1. The whole `repeat` command (Layers 1 and 2)

Command: `node src/cli.ts [maxRuns]`

```mermaid
flowchart TD
    A["Start: node src/cli.ts"] --> B["runOnce: run Vitest, read the JSON report"]
    B --> C{"Does the report file exist?"}
    C -- "no" --> X1["STOP: Vitest crashed. Throw an error."]
    C -- "yes" --> D{"Were any tests found?"}
    D -- "no" --> X2["STOP: zero tests. Throw an error."]
    D -- "yes" --> E["Add one pass or fail to each test's tally"]
    E --> F["decide: one verdict per test"]
    F --> G{"Is any test still undecided?"}
    G -- "no" --> I["Print verdicts and cost"]
    G -- "yes" --> H{"Runs left under maxRuns?"}
    H -- "no" --> I
    H -- "yes" --> J["Next run: only the files that hold an undecided test"]
    J --> B
```

Reading it: the loop only continues while some test is undecided **and** runs
remain. Every pass through the loop narrows which files run.

## 2. `decide`: one test, one verdict (Layer 2)

Inputs: `P` = passes so far, `F` = fails so far, for one test.

```mermaid
flowchart TD
    S["One test has P passes and F fails so far"] --> R1{"P above 0 AND F above 0?"}
    R1 -- "yes" --> V1["flaky: seen both outcomes. Done."]
    R1 -- "no" --> R2{"P is 0, F above 0, and the LOW end of the fail range is above 80%?"}
    R2 -- "yes" --> V2["broken: 16 fails in a row. Done."]
    R2 -- "no" --> R3{"F is 0, P above 0, and the HIGH end of the fail range is below 10%?"}
    R3 -- "yes" --> V3["clean: 35 passes in a row. Done."]
    R3 -- "no" --> V4["undecided: run again"]
```

The first matching rule wins. "Fail range" means the `wilson` range for the true
fail rate.

| Verdict | How many runs it takes |
|---|---|
| flaky | as few as 2 |
| undecided | not a result yet |
| broken | 16 fails in a row |
| clean | 35 passes in a row |

## 3. The `order` command (Layer 3)

Command: `node src/cli.ts order <test-file>`

```mermaid
flowchart TD
    A["Start: order command with one test file"] --> B["For seeds 1 to 20: run the file shuffled with that seed"]
    B --> C{"Did any test fail under any seed?"}
    C -- "no" --> N["Print: no order dependence found"]
    C -- "yes" --> D["For each failing test, take the first seed that failed it"]
    D --> E["confirmSeed: rerun that same seed"]
    E --> F{"Did the test pass in this rerun?"}
    F -- "yes" --> R["random: the seed does not explain the failure"]
    F -- "no" --> G{"Failed 16 reruns in a row?"}
    G -- "no" --> E
    G -- "yes" --> O["order-dependent: reproducible with this seed"]
```

Reading it: a failure that appears under a seed is only trusted if it appears
again **every time** that seed is rerun. One pass is enough to say it is random.

## How the diagrams fit together

| Question | Answered by |
|---|---|
| Did Vitest even run properly? | Diagram 1, the two STOP boxes |
| Is this test flaky, broken or clean? | Diagram 2 |
| Does the failure depend on test order? | Diagram 3 |

## The four fixtures traced through the graph

| Fixture | Diagram 1 and 2 verdict | Diagram 3 verdict |
|---|---|---|
| `stable` | clean after 35 runs | no failure under any seed |
| `random` | flaky after the first fail | random (it passes at some rerun) |
| `timing` | flaky within a few runs | random (it passes at some rerun) |
| `order` | **clean after 35 runs (blind spot)** | **order-dependent** (seed 3, 16 of 16) |

The `order` row is why Layer 3 exists: Diagram 2 alone gets it wrong.
