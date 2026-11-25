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
  ms: number;
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

const ID_SEPARATOR = "\0";

/**
 * Builds a test id from a file path and a test name. The separator is NUL,
 * which cannot occur in a file path, so the id parses unambiguously.
 * @param file - Test file path.
 * @param name - Full test name; may contain any characters.
 * @returns The test id.
 */
export function makeTestId(file: string, name: string): string {
  return `${file}${ID_SEPARATOR}${name}`;
}

/**
 * Extracts the file part of a test id built by makeTestId().
 * @param id - Test id.
 * @returns The file path.
 */
export function fileOfTestId(id: string): string {
  const separatorAt = id.indexOf(ID_SEPARATOR);
  return separatorAt === -1 ? id : id.slice(0, separatorAt);
}

/**
 * Extracts the test name from a test id built by makeTestId().
 * Names containing any characters are returned whole.
 * @param id - Test id.
 * @returns The test name.
 */
export function nameOfTestId(id: string): string {
  const separatorAt = id.indexOf(ID_SEPARATOR);
  return separatorAt === -1 ? "" : id.slice(separatorAt + 1);
}

/**
 * Locates the project's own Vitest entry point under the working directory.
 * @returns Absolute path to vitest.mjs.
 * @throws If node_modules/vitest is missing.
 */
function vitestEntry(): string {
  const entry = resolve("node_modules/vitest/vitest.mjs");
  if (!existsSync(entry)) {
    throw new Error(
      `Cannot find ${entry}. Run flakescope from the project root, after installing its dependencies.`,
    );
  }
  return entry;
}

/**
 * Runs Vitest once and collects the results.
 * @param files - Test files to run; empty runs everything.
 * @param extraArgs - Extra Vitest CLI arguments.
 * @param env - Extra environment variables for the child process.
 * @returns The per-test results, or a crash result if Vitest produced no report.
 */
export async function runOnce(
  files: string[] = [],
  extraArgs: string[] = [],
  env: Record<string, string> = {},
): Promise<RunResult> {
  const dir = await mkdtemp(join(tmpdir(), "flakescope-"));
  try {
    return await runInDir(dir, files, extraArgs, env);
  } finally {

    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Does the work of runOnce, writing Vitest's JSON report into dir.
 * @param dir - Existing scratch directory.
 * @param files - Test files to run.
 * @param extraArgs - Extra Vitest CLI arguments.
 * @param env - Extra environment variables.
 * @returns Parsed results, or a crash result when no report file exists.
 */
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
        id: makeTestId(file.name, t.fullName),
        status: toStatus(t.status),
        ms: Math.round(t.duration ?? 0),
      });
    }
  }

  return { kind: "ok", tests: testArr };
}

/**
 * Returns the tests of a run, treating a crash or an empty run as a broken setup.
 * @param result - Result from runOnce().
 * @returns The test results.
 * @throws On a crash or when no tests ran.
 */
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
  failRate: Interval;

  passMedianMs: number | undefined;
  failMedianMs: number | undefined;
};

const RUNS_AT_ONCE = 2;

/**
 * Repeats the suite until every test has a decided verdict or the budget is
 * spent. Each round reruns only files that still hold an undecided test.
 * Skipped tests count as neither pass nor fail.
 * @param maxRuns - Maximum number of suite runs.
 * @param startFiles - Files to run first; empty runs everything.
 * @returns One summary per test seen.
 */
export async function runMany(
  maxRuns: number,
  startFiles: string[] = [],
): Promise<TestSummary[]> {

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
