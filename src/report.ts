// Layer 6: turn a Diagnosis into something a reader can use.
//
//   buildReport()  -> a plain object, printed as JSON for coding agents and CI
//   formatText()   -> the same facts as readable text for a person
//
// Both come from ONE Report object, so the two can never disagree.
// Nothing here runs Vitest. It is pure, like classify.ts, so it has fast tests.

import { relative } from "node:path";
import type { Diagnosis } from "./diagnose.ts";
import type { Finding, Evidence } from "./classify.ts";

// Bump this if a field is renamed or removed, so an agent can tell.
export const SCHEMA_VERSION = 1;

export type ReportFinding = Finding & {
  // A shell command that shows the problem, or null if there is none.
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
  // true when something is wrong (any cause except "none").
  hasProblem: boolean;
  findings: ReportFinding[];
};

// The most useful thing for an agent: a command that makes the failure happen.
function reproduceCommand(
  finding: Finding,
  evidence: Evidence,
  file: string,
): string | null {
  switch (finding.cause) {
    case "order-dependence":
      if (evidence.order.verdict !== "order-dependent") return null;
      return (
        `pnpm exec vitest run ${file} --sequence.shuffle.tests ` +
        `--sequence.seed=${evidence.order.seed}`
      );
    case "math-random":
      if (evidence.random.verdict !== "random-driven") return null;
      return (
        `FLAKESCOPE_RANDOM_SEED=${evidence.random.seed} ` +
        `pnpm exec vitest run ${file} --config=.flakescope/random.config.ts`
      );
    case "cpu-load":
      // 8 copies at once put the CPU under load.
      return (
        `for i in 1 2 3 4 5 6 7 8; do pnpm exec vitest run ${file} & done; wait`
      );
    case "deterministic-failure":
      return `pnpm exec vitest run ${file}`;
    default:
      return null;
  }
}

// `root`: paths in the report are shown relative to this folder.
export function buildReport(diagnosis: Diagnosis, root: string): Report {
  const { testId, evidence, findings } = diagnosis;
  const separatorAt = testId.indexOf("::");
  const absoluteFile = testId.slice(0, separatorAt);
  const name = testId.slice(separatorAt + 2);
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

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

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
