// buildReport() gives the JSON for agents and CI; formatText() renders the
// same Report for people, so the two cannot disagree. Pure; no Vitest runs.

import { relative } from "node:path";
import type { Diagnosis } from "./diagnose.ts";
import type { Finding, Evidence } from "./classify.ts";

// Bump when a field is renamed or removed.
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

// A shell command that makes the failure happen, or null.
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
      return (
        `for i in 1 2 3 4 5 6 7 8; do pnpm exec vitest run ${file} & done; wait`
      );
    case "deterministic-failure":
      return `pnpm exec vitest run ${file}`;
    default:
      return null;
  }
}

// Paths in the report are relative to root.
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
