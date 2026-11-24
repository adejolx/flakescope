# Decision graph: what the tool does and why

Diagrams for every layer, from the whole tool down to the details. Mermaid renders in
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

## 4. `findPolluters`: which test breaks the victim (Layer 3b)

Runs after `order` confirms a victim. Each probe runs the victim plus a group
of other tests under shuffle seeds 1 to 8 and asks: did the victim fail?

```mermaid
flowchart TD
    A["Victim confirmed order-dependent"] --> B{"Probe: victim alone. Does it fail?"}
    B -- "yes" --> X1["STOP: fails on its own, not an order problem"]
    B -- "no" --> C{"Probe: victim + ALL other tests. Does it fail?"}
    C -- "no" --> X2["STOP: cannot reproduce with these seeds"]
    C -- "yes" --> D{"More than one candidate left?"}
    D -- "no" --> R["Return the candidate: the polluter"]
    D -- "yes" --> E["Split candidates into two halves"]
    E --> F{"Probe: victim + first half fails?"}
    F -- "yes" --> G["Keep the first half"]
    F -- "no" --> H{"Probe: victim + second half fails?"}
    H -- "yes" --> I["Keep the second half"]
    H -- "no" --> J["Return all remaining: they pollute together"]
    G --> D
    I --> D
```

Why probes work: a polluter lands before the victim in about half of all
seeds, so 8 seeds miss it about 0.4% of the time.

## 5. The probes (Layer 4)

Command: `node src/cli.ts probe <test-file> "<test name>"`

```mermaid
flowchart TD
    A["Start: one flaky test"] --> B["Probe 1: run with Math.random fixed to seeds 1 to 16"]
    B --> C{"Did the test fail under any seed?"}
    C -- "no" --> R1["inconclusive: failing values may just be rare"]
    C -- "yes" --> D["confirmSeed: rerun the first failing seed"]
    D --> E{"Fails 16 reruns in a row?"}
    E -- "yes" --> R2["random-driven: Math.random decides the result"]
    E -- "no" --> R3["not-random-driven: that seed passed on a rerun"]
    R1 --> L
    R2 --> L
    R3 --> L
    L["Probe 2: run alone, then 8 copies at once as CPU load"] --> M{"Is the loaded fail range entirely above the alone range?"}
    M -- "yes" --> R4["load-sensitive"]
    M -- "no" --> R5["no-load-effect"]
```

## 6. `diagnose` and `classify` (Layer 5)

Command: `node src/cli.ts diagnose <test-file> "<test name>" [--json]`

```mermaid
flowchart TD
    A["runMany on this file only"] --> B{"Verdict broken?"}
    B -- "yes" --> K1["deterministic-failure, high. Skip the probes."]
    B -- "no" --> C["Run probes one after another: order, Math.random, CPU load"]
    C --> D{"Load-sensitive?"}
    D -- "yes" --> T["Order and random findings drop to medium confidence"]
    D -- "no" --> T2["Order and random findings stay high"]
    T --> E
    T2 --> E
    E["Collect every rule that fired: order-dependence, math-random, cpu-load"] --> F{"Any finding?"}
    F -- "yes" --> G["Sort by confidence, highest first"]
    F -- "no" --> H{"Repeat verdict flaky?"}
    H -- "yes" --> U["unknown, low: no probe explains it"]
    H -- "no" --> N["none: no flake observed"]
```

More than one cause can fire at once, so the result is a list.

Why the confidence drop: the order and `Math.random` scans run Vitest copies in
parallel, which adds CPU load. For a load-sensitive test that load could be
what made it fail.

## 7. The report (Layer 6)

```mermaid
flowchart TD
    A["Diagnosis"] --> B["buildReport: one Report object"]
    B --> C["Add a reproduce command per finding"]
    C --> D{"--json?"}
    D -- "yes" --> E["Print JSON for agents and CI"]
    D -- "no" --> F["formatText: same facts as readable text"]
    E --> G{"Any finding other than none?"}
    F --> G
    G -- "yes" --> H["Exit code 1"]
    G -- "no" --> I["Exit code 0"]
```

Both outputs come from one Report, so they cannot disagree.

## How the diagrams fit together

| Question | Answered by |
|---|---|
| Did Vitest even run properly? | Diagram 1, the two STOP boxes |
| Is this test flaky, broken or clean? | Diagram 2 |
| Does the failure depend on test order? | Diagram 3 |
| Which test causes the order problem? | Diagram 4 |
| Does Math.random or CPU load drive it? | Diagram 5 |
| What is the likely cause, and how sure? | Diagram 6 |
| What do a person or an agent receive? | Diagram 7 |

## The four fixtures traced through the graph

| Fixture | Diagram 1 and 2 verdict | Diagram 3 verdict |
|---|---|---|
| `stable` | clean after 35 runs | no failure under any seed |
| `random` | flaky after the first fail | random (it passes at some rerun) |
| `timing` | flaky within a few runs | random (it passes at some rerun) |
| `order` | **clean after 35 runs (blind spot)** | **order-dependent** (seed 3, 16 of 16) |

The `order` row is why Layer 3 exists: Diagram 2 alone gets it wrong.
