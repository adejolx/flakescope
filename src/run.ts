import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { decide, median, wilson } from "./stats.ts";
import type { Interval, Verdict } from "./stats.ts";

export type TestStatus = "passed" | "failed" | "other";
export type TestResult = {
  id: string;
  status: TestStatus;
  ms: number; // how long the test took, from Vitest's own report
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

// Test ids look like "/abs/path/file.test.tsx::test name".
export function fileOfTestId(id: string): string {
  const parts = id.split("::");
  return parts[0];
}

export function nameOfTestId(id: string): string {
  const separatorAt = id.indexOf("::");
  return id.slice(separatorAt + 2);
}

// The tool is started from the project's root folder, so this is the
// project's own Vitest. (Needs a node_modules folder: not yarn Plug'n'Play.)
function vitestEntry(): string {
  const entry = resolve("node_modules/vitest/vitest.mjs");
  if (!existsSync(entry)) {
    throw new Error(
      `Cannot find ${entry}. Run flakescope from the project root, after installing its dependencies.`,
    );
  }
  return entry;
}

// files: limit the run to these test files (empty: all).
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
      // Run the project's own Vitest with this same Node. That works with
      // pnpm, yarn and npm alike, and skips the package manager's startup.
      process.execPath,
      [
        vitestEntry(),
        "run",
        "--reporter=json",
        `--outputFile=${outPath}`,
        ...extraArgs,
        ...files,
      ],
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
      testArr.push({
        id: `${file.name}::${t.fullName}`,
        status: toStatus(t.status),
        ms: Math.round(t.duration ?? 0),
      });
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
  // The typical time of a passing run and of a failing run (undefined if the
  // test never passed or never failed). A big gap is evidence: see classify.ts.
  passMedianMs: number | undefined;
  failMedianMs: number | undefined;
};

// Copies of the suite run at once. On 8 cores a 130 ms render took 137 ms at
// 2 at once (fine) and 174 ms at 4 (distorts timing). Set to 1 for a quiet
// baseline.
const RUNS_AT_ONCE = 2;

export async function runMany(
  maxRuns: number,
  startFiles: string[] = [],
): Promise<TestSummary[]> {
  // Skipped tests count as neither pass nor fail.
  const counts = new Map<
    string,
    { passes: number; fails: number; passMs: number[]; failMs: number[] }
  >();

  let files: string[] = startFiles;

  for (let i = 0; i < maxRuns; i += RUNS_AT_ONCE) {
    const copies = Math.min(RUNS_AT_ONCE, maxRuns - i);
    const batch = await Promise.all(
      Array.from({ length: copies }, async () => unwrap(await runOnce(files))),
    );

    for (const tests of batch) {
      for (const t of tests) {
        const c = counts.get(t.id) ?? { passes: 0, fails: 0, passMs: [], failMs: [] };
        if (t.status === "passed") {
          c.passes++;
          c.passMs.push(t.ms);
        } else if (t.status === "failed") {
          c.fails++;
          c.failMs.push(t.ms);
        }
        counts.set(t.id, c);
      }
    }

    // Next run: only files that still hold an undecided test.
    const undecidedFiles = new Set<string>();
    for (const [id, c] of counts) {
      const verdict = decide(c.passes, c.fails);
      if (verdict === "undecided") {
        undecidedFiles.add(fileOfTestId(id));
      }
    }

    if (undecidedFiles.size === 0) {
      break;
    }

    files = [];
    for (const file of undecidedFiles) {
      files.push(file);
    }
  }

  const summaries: TestSummary[] = [];
  for (const [id, c] of counts) {
    const total = c.passes + c.fails;

    // Every run skipped: no information, so the full range.
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
      passMedianMs: median(c.passMs),
      failMedianMs: median(c.failMs),
    });
  }
  return summaries;
}
