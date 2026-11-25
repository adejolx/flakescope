import { relative } from "node:path";
import { fileOfTestId, nameOfTestId } from "./run.ts";
import { formatPercent as pct } from "./stats.ts";
import type { Diagnosis } from "./diagnose.ts";
import type { Finding, Evidence } from "./classify.ts";

export const SCHEMA_VERSION = 1;

export type ReportFinding = Finding & {
  reproduce: string | null;
};

export type Report = {
  schemaVersion: typeof SCHEMA_VERSION;
  test: { file: string; name: string; id: string };
  observed: {
    verdict: Evidence["repeat"]["verdict"];
    passes: number;
    fails: number;
    failRate: { low: number; high: number };
  };
  hasProblem: boolean;
  findings: ReportFinding[];
};

/**
 * Builds a shell command that makes the diagnosed failure happen.
 * @param finding - The finding to reproduce.
 * @param evidence - Evidence holding the seeds the command needs.
 * @param file - Test file path, relative to the project root.
 * @returns The command, or null when the cause has no reproduction.
 */
function reproduceCommand(
  finding: Finding,
  evidence: Evidence,
  file: string,
): string | null {
  switch (finding.cause) {
    case "order-dependence":
      if (evidence.order.verdict !== "order-dependent") return null;
      return (
        `npx vitest run ${file} --sequence.shuffle.tests ` +
        `--sequence.seed=${evidence.order.seed}`
      );
    case "math-random":
      if (evidence.random.verdict !== "random-driven") return null;
      return (
        `FLAKESCOPE_RANDOM_SEED=${evidence.random.seed} ` +
        `npx vitest run ${file} --config=.flakescope/random.config.mts`
      );
    case "cpu-load":
      return (
        `for i in 1 2 3 4 5 6 7 8; do npx vitest run ${file} & done; wait`
      );
    case "wait-timeout":

      return `for i in $(seq 30); do npx vitest run ${file} || break; done`;
    case "deterministic-failure":
      return `npx vitest run ${file}`;
    default:
      return null;
  }
}

/**
 * Builds the machine-readable report for a diagnosis.
 * @param diagnosis - Result of diagnose().
 * @param root - Directory the reported file path is made relative to.
 * @returns A JSON-serialisable report.
 */
export function buildReport(diagnosis: Diagnosis, root: string): Report {
  const { testId, evidence, findings } = diagnosis;
  const absoluteFile = fileOfTestId(testId);
  const name = nameOfTestId(testId);
  const file = relative(root, absoluteFile);

  return {
    schemaVersion: SCHEMA_VERSION,
    test: { file, name, id: testId },
    observed: {
      verdict: evidence.repeat.verdict,
      passes: evidence.repeat.passes,
      fails: evidence.repeat.fails,
      failRate: evidence.repeat.failRate,
    },
    hasProblem: findings.some((f) => f.cause !== "none"),
    findings: findings.map((f) => ({
      ...f,
      reproduce: reproduceCommand(f, evidence, file),
    })),
  };
}

/**
 * Renders a report as plain text for people.
 * @param report - Report from buildReport().
 * @returns Multi-line text: header, then one block per finding.
 */
export function formatText(report: Report): string {
  const o = report.observed;
  const runs = o.passes + o.fails;
  const lines: string[] = [
    `test:      ${report.test.name}`,
    `file:      ${report.test.file}`,
    `observed:  ${o.verdict}, ${o.fails} fails in ${runs} runs ` +
      `(fail rate ${pct(o.failRate.low)}..${pct(o.failRate.high)})`,
    "",
  ];

  for (const f of report.findings) {
    lines.push(`${f.cause.toUpperCase()}  (${f.confidence} confidence)`);
    lines.push("  evidence:");
    for (const line of f.because) lines.push(`    - ${line}`);
    lines.push(`  fix: ${f.suggestion}`);
    if (f.reproduce !== null) lines.push(`  reproduce: ${f.reproduce}`);
    lines.push("");
  }

  return lines.join("\n");
}
