# Guide 6: reports for agents and people

Goal: the same diagnosis, in the form each reader needs.

    node src/cli.ts diagnose <file> "<test name>"          # for a person
    node src/cli.ts diagnose <file> "<test name>" --json   # for an agent or CI

## One source, two views

`buildReport()` in `src/report.ts` builds ONE plain object (`Report`).
`formatText()` turns it into text. `JSON.stringify` turns it into JSON.
Both views come from the same object, so they can't disagree.

Like `classify.ts`, `report.ts` runs nothing. Its tests take milliseconds:

    node --test src/report.test.ts src/classify.test.ts

## What an agent needs (and why the JSON has it)

| field | why an agent wants it |
|---|---|
| `schemaVersion` | so it can tell if the format changed |
| `test.file`, `test.name` | where to look; paths are relative to the repo |
| `observed` | how often it fails, as a range, not a single guess |
| `hasProblem` | one yes/no to branch on |
| `findings[].cause` | a fixed set of words: `order-dependence`, `math-random`, `cpu-load`, `deterministic-failure`, `unknown`, `none` |
| `findings[].confidence` | `high`, `medium` or `low`: how much to trust it |
| `findings[].because` | the evidence, one line each, quotable |
| `findings[].suggestion` | what to change |
| `findings[].reproduce` | **a command that makes the failure happen** |

`reproduce` is the most useful field. An agent can run it, change the code,
run it again, and see the failure go away. That is a feedback loop it can
check without asking anyone.

## Rules for the JSON output

- With `--json`, stdout holds ONLY the JSON. Nothing else is printed there.
- Exit code: `0` = no problem found, `1` = a problem was found. A CI job
  can fail on that.

## Example (shortened)

    {
      "schemaVersion": 1,
      "test": { "file": "fixtures/order.test.tsx", "name": "order: reader assumes empty cache", ... },
      "observed": { "verdict": "clean", "passes": 36, "fails": 0, "failRate": { "low": 0, "high": 0.1 } },
      "hasProblem": true,
      "findings": [{
        "cause": "order-dependence",
        "confidence": "high",
        "because": ["fails every time under shuffle seed 3", "polluted by: order: writer populates cache"],
        "suggestion": "Shared state leaks between tests. Reset it in a beforeEach/afterEach, ...",
        "reproduce": "pnpm exec vitest run fixtures/order.test.tsx --sequence.shuffle.tests --sequence.seed=3"
      }]
    }

Note `observed.verdict` is `clean` and `hasProblem` is `true`. A normal run
never shows this test failing. Only shuffled order does.

## Exercise (do this one yourself)

Add a `--md` flag that prints a Markdown report for a GitLab merge request
comment. Write `formatMarkdown(report: Report): string` in `report.ts`:
a heading with the test name, a table row per finding, and the `reproduce`
command in a fenced code block. Add one test in `report.test.ts` first
(`assert.match(markdown, /```bash/)`), then make it pass.
