import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, wilson } from "./stats.ts";
import type { Interval, Verdict } from "./stats.ts";

export type TestStatus = "passed" | "failed" | "other";
export type TestResult = {
  id: string;
  status: TestStatus;
};
export type RunResult =
  | { kind: "ok"; tests: TestResult[] }
  | { kind: "crash"; exitCode: number | string | null; stderr: string };

const execFileAsync = promisify(execFile);

function toStatus(s: string): TestStatus {
  if (s === "passed") return "passed";
  if (s === "failed") return "failed";
  return "other";
}

// A test id looks like "/abs/path/file.test.tsx::test name".
// This returns the part before "::", the file path.
export function fileOfTestId(id: string): string {
  const parts = id.split("::");
  return parts[0];
}

// ...and this returns the part after the first "::", the test name.
export function nameOfTestId(id: string): string {
  const separatorAt = id.indexOf("::");
  return id.slice(separatorAt + 2);
}

// files:     limit the run to these test files. Empty means every file.
// extraArgs: extra flags passed to Vitest, for example a shuffle seed.
// env:       extra environment variables for the Vitest process.
export async function runOnce(
  files: string[] = [],
  extraArgs: string[] = [],
  env: Record<string, string> = {},
): Promise<RunResult> {
  const dir = await mkdtemp(join(tmpdir(), "flakescope-"));
  try {
    return await runInDir(dir, files, extraArgs, env);
  } finally {
    // runInDir has read the result file by now, so the folder can go.
    // `finally` runs on a return AND on a thrown error: no leaks either way.
    await rm(dir, { recursive: true, force: true });
  }
}

// Does the actual work of runOnce, using `dir` for Vitest's result file.
async function runInDir(
  dir: string,
  files: string[],
  extraArgs: string[],
  env: Record<string, string>,
): Promise<RunResult> {
  const outPath = join(dir, "result.json");

  let exitCode: number | string | null = 0;
  let stderr = "";

  try {
    await execFileAsync(
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        "--reporter=json",
        `--outputFile=${outPath}`,
        ...extraArgs,
        ...files,
      ],
      // Keep the normal environment and add ours on top.
      { env: { ...process.env, ...env } },
    );
  } catch (e) {
    const err = e as { code: number | string; stderr: string };
    exitCode = err.code;
    stderr = err.stderr;
  }

  const testArr: TestResult[] = [];
  let raw: string;

  try {
    raw = await readFile(outPath, "utf8");
  } catch {
    return { kind: "crash", exitCode, stderr };
  }
  const report = JSON.parse(raw);

  for (const file of report.testResults) {
    for (const t of file.assertionResults) {
      testArr.push({ id: `${file.name}::${t.fullName}`, status: toStatus(t.status) });
    }
  }

  return { kind: "ok", tests: testArr };
}

// A crash or an empty run is a broken setup, not a test result: throw.
export function unwrap(result: RunResult): TestResult[] {
  if (result.kind === "crash") {
    throw new Error(
      `A crash is not a flake. exit code: ${result.exitCode}, stderr: ${result.stderr}`,
    );
  }
  if (result.tests.length === 0) throw new Error("Zero results");
  return result.tests;
}

export type TestSummary = {
  id: string;
  passes: number;
  fails: number;
  verdict: Verdict;
  failRate: Interval; // true fail rate is probably inside this range
};

// How many copies of the suite runMany starts at the same time.
// Measured on 8 cores, rendering a 3000-row list (130 ms alone):
//   2 at once -> 137 ms median, 155 max   (about +5%: fine)
//   4 at once -> 174 ms median, 238 max   (distorts timing: too much)
// 2 roughly halves the time to prove a test clean (35 runs). It still adds a
// little load, so a very tight timing budget could be nudged. Set to 1 for a
// perfectly quiet baseline.
const RUNS_AT_ONCE = 2;

// startFiles: limit every run to these test files. Empty means the whole suite.
export async function runMany(
  maxRuns: number,
  startFiles: string[] = [],
): Promise<TestSummary[]> {
  // id -> running tally. "other" (skipped) is counted as neither.
  const counts = new Map<string, { passes: number; fails: number }>();

  let files: string[] = startFiles; // first run: everything, or startFiles

  for (let i = 0; i < maxRuns; i += RUNS_AT_ONCE) {
    // Run RUNS_AT_ONCE copies together, but never go past maxRuns.
    const copies = Math.min(RUNS_AT_ONCE, maxRuns - i);
    const batch = await Promise.all(
      Array.from({ length: copies }, async () => unwrap(await runOnce(files))),
    );

    for (const tests of batch) {
      for (const t of tests) {
        const c = counts.get(t.id) ?? { passes: 0, fails: 0 };
        if (t.status === "passed") {
          c.passes++;
        } else if (t.status === "failed") {
          c.fails++;
        }
        counts.set(t.id, c);
      }
    }

    // Next run: only the files that still hold an undecided test.
    // A Set keeps each file path once, even if it holds several tests.
    const undecidedFiles = new Set<string>();
    for (const [id, c] of counts) {
      const verdict = decide(c.passes, c.fails);
      if (verdict === "undecided") {
        undecidedFiles.add(fileOfTestId(id));
      }
    }

    if (undecidedFiles.size === 0) {
      break; // every test has a verdict: stop
    }

    files = [];
    for (const file of undecidedFiles) {
      files.push(file);
    }
  }

  const summaries: TestSummary[] = [];
  for (const [id, c] of counts) {
    const total = c.passes + c.fails;

    // No finished runs (every run skipped): we know nothing, so the full range.
    let failRate: Interval = { low: 0, high: 1 };
    if (total > 0) {
      failRate = wilson(c.fails, total);
    }

    summaries.push({
      id,
      passes: c.passes,
      fails: c.fails,
      verdict: decide(c.passes, c.fails),
      failRate,
    });
  }
  return summaries;
}
