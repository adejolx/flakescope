# Layer 1: the repeat runner

**One line:** run the test suite once, and report each test as passed or failed,
so a caller can repeat it and count.

File: [`src/run.ts`](../src/run.ts)

## Why this layer exists

A flaky test passes sometimes and fails sometimes. One run can't show that.
You need many runs, with each result recorded per test. This layer does one
run and returns clean data. Layer 2 repeats it.

## The pieces

| Name | What it does |
|---|---|
| `runOnce(files, extraArgs)` | Runs Vitest once. Returns a `RunResult`. |
| `RunResult` | Either `ok` (a list of tests) or `crash` (exit code and stderr). |
| `TestResult` | One test: an `id` and a `status`. |
| `toStatus(s)` | Turns Vitest's status text into `passed`, `failed` or `other`. |
| `unwrap(result)` | Returns the tests, or throws if the run crashed or found no tests. |
| `fileOfTestId(id)` / `nameOfTestId(id)` | Split an id into file path and test name. |

## How `runOnce` works

1. Make a fresh temp folder. Each run gets its own, so runs never share files.
2. Run `pnpm exec vitest run --reporter=json --outputFile=<temp file>` as a
   child process. `extraArgs` go in before the file paths.
3. If Vitest exits non-zero, remember the exit code and stderr. **Do not stop.**
   A failing test also exits non-zero.
4. Try to read the JSON file.
   - File missing: Vitest crashed. Return `{ kind: "crash", exitCode, stderr }`.
   - File there: parse it and build one `TestResult` per test.

## The one trick to remember: crash or failed test?

Vitest exits with code 1 in both cases. The only difference is the output file.

| Situation | Exit code | JSON file |
|---|---|---|
| A test failed | 1 | exists |
| Vitest crashed (for example, bad config) | 1 | **missing** |

So the tool checks for the file, not the exit code.

## Test identity

A test's id is `<absolute file path>::<full test name>`. Two files can hold a
test with the same name, so the name alone is not enough.

## Empty runs are errors, not results

If Vitest runs but finds zero tests, it still writes a valid file with an empty
list. Running from the wrong folder does this. `unwrap` throws on it, so a
broken setup never looks like "everything passed".

## Try it

```bash
node src/cli.ts 20
```

This runs the suite up to 20 times. (Layer 2 may stop earlier.)

## Verified result (fixed 20 runs, before Layer 2)

| Test | Passed |
|---|---|
| stable | 20/20 |
| random | 18/20 |
| timing | 6/20 |
| order (both tests) | 20/20 |

`order` looks healthy here. It isn't. That is Layer 3's job.

## Limits

- One run costs about 1.5 seconds, mostly Vitest startup. 20 runs took 32 s.
- It runs the suite in file order only. Order-related flakes stay hidden.
- Runs are one after another, not in parallel. This is on purpose: parallel
  runs compete for the CPU and cause timing flakes of their own.
