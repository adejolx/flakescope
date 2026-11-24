# Guide 1: the repeat runner (`src/run.ts`)

Goal: run the Vitest suite N times, and report how many times each test passed.
You'll build it in 5 small steps. Run the checkpoint after each step before
moving on. Every step names the exact API to use.

Run TypeScript directly with Node (v24 can do this, no build step):

    node src/run.ts

Two rules for this: import local files with the `.ts` extension, and don't use
`enum`. Everything else is normal TypeScript.

---

## Step 0: see the raw material (no code)

Run this in your terminal from the repo root:

    pnpm exec vitest run --reporter=json --outputFile=out.json

Open `out.json`. Verified shape (trimmed):

    {
      "success": false,
      "testResults": [                       // one entry per test FILE
        {
          "name": "/abs/path/fixtures/order.test.tsx",
          "status": "passed",
          "assertionResults": [              // one entry per TEST
            { "fullName": "order: reader assumes empty cache",
              "status": "passed" },          // "passed" | "failed" | ...
            ...
          ]
        }
      ]
    }

Notice two things, you'll need both later:
1. The test's identity is **file `name` + `fullName`**. The same `fullName`
   could appear in two files.
2. The terminal exit code is `1` when any test fails.

Now run it with a deliberately broken config:

    pnpm exec vitest run --reporter=json --outputFile=crash.json --config=nope.ts
    echo $?

Exit code is `1` again, but `crash.json` was never created. **That is how you
tell "a test failed" from "Vitest crashed".** Tests failed: exit 1 AND the file
exists. Crash: no file. Keep this in mind for step 3.

Delete `out.json` and `crash.json` when done.

---

## Step 1: types (what a result looks like)

At the top of `src/run.ts`, write three types. The point: decide your data
shape before the logic.

    export type TestStatus = 'passed' | 'failed' | 'other';

    export type TestResult = {
      id: string;          // `${file}::${fullName}`  <- your identity key
      status: TestStatus;
    };

    export type RunResult =
      | { kind: 'ok'; tests: TestResult[] }
      | { kind: 'crash'; exitCode: number | null; stderr: string };

`RunResult` is a **discriminated union**: the `kind` field tells TypeScript
which shape you have. This forces callers to handle the crash case.

Checkpoint: `node src/run.ts` runs without errors (the file does nothing yet).

---

## Step 2: run Vitest as a child process

API: `execFile` from `node:child_process`, wrapped with `promisify` from
`node:util` so you can `await` it.

    import { execFile } from 'node:child_process';
    import { promisify } from 'node:util';
    const execFileAsync = promisify(execFile);

Calling it:

    const { stdout, stderr } = await execFileAsync(
      'pnpm',
      ['exec', 'vitest', 'run', '--reporter=json', `--outputFile=${outPath}`],
    );

**Gotcha you must handle:** `execFileAsync` *throws* when the exit code is
non-zero, and a failing test makes Vitest exit 1. So a failing test looks like
an exception. The thrown error object has `.code` (exit code) and `.stderr`.
Wrap the call in `try/catch` and, in the `catch`, do NOT treat it as a crash
yet. Just remember the exit code and carry on to step 3.

For `outPath`, make a unique temp file per run so parallel runs later don't
collide:

    import { mkdtemp } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    const dir = await mkdtemp(join(tmpdir(), 'flakescope-'));
    const outPath = join(dir, 'result.json');

Checkpoint: add a temporary `console.log(outPath)` after the call, run
`node src/run.ts`, then `cat` that path to see Vitest's JSON.

---

## Step 3: read the file, decide ok vs crash

API: `readFile` from `node:fs/promises`, and `JSON.parse`.

Logic (this is the part to think through yourself):
- Try to `readFile(outPath, 'utf8')`. If that throws (file missing) →
  return `{ kind: 'crash', exitCode, stderr }`.
- Otherwise parse it and flatten:
  for each `file` in `report.testResults`, for each `t` in
  `file.assertionResults`, push
  `{ id: `${file.name}::${t.fullName}`, status }`.
- Map Vitest's status to yours: `'passed'` → `'passed'`, `'failed'` →
  `'failed'`, anything else → `'other'` (skipped, todo).

### The mapping: Vitest JSON → your `TestResult`

Each JSON level maps to one loop. Arrays use `for...of` (it gives you the
items). `for...in` would give you the index strings `"0"`, `"1"` instead.

| Vitest JSON                              | Loop                                  | Your type             |
|------------------------------------------|---------------------------------------|-----------------------|
| `report.testResults` (array of files)    | `for (const file of ...)`             |                       |
| `file.assertionResults` (array of tests) | `for (const t of ...)`                |                       |
| `file.name` + `t.fullName`               |                                       | `TestResult.id` = `` `${file.name}::${t.fullName}` `` |
| `t.status`                               |                                       | `TestResult.status`   |

Status mapping (`t.status` → `TestResult.status`):

| Vitest value | Yours      |
|--------------|------------|
| `"passed"`   | `"passed"` |
| `"failed"`   | `"failed"` |
| anything else (`"skipped"`, `"todo"`, ...) | `"other"` |

How to code the status mapping: write a small helper above `runOnce`.
`t.status` arrives as a plain string, and your `TestStatus` only allows three
values, so the helper converts one to the other:

    function toStatus(s: string): TestStatus {
      if (s === "passed") return "passed";
      if (s === "failed") return "failed";
      return "other";
    }

Then in the loop, use it when you build each result:

    status: toStatus(t.status)

Why a helper and not `status: t.status`? TypeScript rejects that line:
`string` is wider than `"passed" | "failed" | "other"`. The helper is the
single place that decides what counts as passed, failed or other.

Shape of the loop (fill in the bodies yourself):

    const tests: TestResult[] = [];
    for (const file of report.testResults) {
      for (const t of file.assertionResults) {
        // push one TestResult here
      }
    }

Put this in `export async function runOnce(): Promise<RunResult>`.

Checkpoint: `console.log(await runOnce())` shows 5 tests (stable, timing,
order x2, random). Then run it with `--config=nope.ts` hardcoded temporarily
and confirm you get `kind: 'crash'`. Remove that hack.

---

## Step 4: repeat N times and tally

    export async function runMany(n: number): Promise<Map<string, number>>

Do it **sequentially** first (a plain `for` loop with `await`). Parallel comes
later; getting it right first matters more.

- Keep a `Map<string, number>` of `id -> pass count`.
- After each `runOnce()`: if `kind === 'crash'`, throw an Error (a crash is
  not a flake, don't count it). If `ok`, for each test with status `'passed'`
  add 1 to its count (`map.get(id) ?? 0`). Make sure a test that **never**
  passed still appears in the map with 0, otherwise you'll hide always-failing
  tests.

Checkpoint, at the bottom of the file:

    const n = 20;
    const tally = await runMany(n);
    for (const [id, passes] of tally) console.log(`${passes}/${n}  ${id}`);

Run `node src/run.ts` (~1 min). Expect: stable 20/20, order 20/20 (not
shuffled, remember), random ~18/20, timing noticeably lower.

---

## Step 5: make the entry point a proper CLI

Replace the hardcoded `n` with an argument. API: `process.argv`.
`node src/run.ts 30` puts `'30'` at `process.argv[2]`. Convert with `Number()`
and default to 20 if missing or not a number.

---

## When you're done

Paste `src/run.ts` here. I'll review it. Also answer the check question from
LAYERS.md: why doesn't 5 failures in 20 runs prove a 25% flake rate?

Stuck? Tell me the step number and what you saw (error text or output).
