// Run with: node --test src/report.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport, formatText, SCHEMA_VERSION } from "./report.ts";
import { classify } from "./classify.ts";
import type { Evidence } from "./classify.ts";
import type { Diagnosis } from "./diagnose.ts";

const range = (low: number, high: number) => ({ low, high });

const quiet: Evidence = {
  scanConcurrency: 4,
  repeat: { verdict: "clean", passes: 36, fails: 0, failRate: range(0, 0.1) },
  order: { verdict: "not-order-dependent" },
  random: { verdict: "inconclusive" },
  load: { verdict: "no-load-effect", alone: range(0, 0.1), loaded: range(0, 0.19) },
};

function diagnosisFor(evidence: Evidence): Diagnosis {
  return {
    testId: "/proj/fixtures/a.test.tsx::a: does a thing",
    evidence,
    findings: classify(evidence),
  };
}

test("report carries the schema version and relative file path", () => {
  const r = buildReport(diagnosisFor(quiet), "/proj");
  assert.equal(r.schemaVersion, SCHEMA_VERSION);
  assert.equal(r.test.file, "fixtures/a.test.tsx");
  assert.equal(r.test.name, "a: does a thing");
});

test("no cause found: hasProblem is false and nothing to reproduce", () => {
  const r = buildReport(diagnosisFor(quiet), "/proj");
  assert.equal(r.hasProblem, false);
  assert.equal(r.findings[0].reproduce, null);
});

test("order dependence: reproduce command uses the failing shuffle seed", () => {
  const r = buildReport(
    diagnosisFor({
      ...quiet,
      order: { verdict: "order-dependent", seed: 3, polluters: ["writer"] },
    }),
    "/proj",
  );
  assert.equal(r.hasProblem, true);
  assert.equal(
    r.findings[0].reproduce,
    "npx vitest run fixtures/a.test.tsx --sequence.shuffle.tests --sequence.seed=3",
  );
});

test("math random: reproduce command sets the seed env var", () => {
  const r = buildReport(
    diagnosisFor({ ...quiet, random: { verdict: "random-driven", seed: 4 } }),
    "/proj",
  );
  assert.match(r.findings[0].reproduce ?? "", /^FLAKESCOPE_RANDOM_SEED=4 /);
});

test("the report survives JSON.stringify and JSON.parse unchanged", () => {
  const r = buildReport(
    diagnosisFor({
      ...quiet,
      load: { verdict: "load-sensitive", alone: range(0, 0.1), loaded: range(0.8, 1) },
    }),
    "/proj",
  );
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
});

test("text report shows evidence, fix and reproduce lines", () => {
  const text = formatText(
    buildReport(
      diagnosisFor({
        ...quiet,
        order: { verdict: "order-dependent", seed: 3, polluters: ["writer"] },
      }),
      "/proj",
    ),
  );
  assert.match(text, /ORDER-DEPENDENCE/);
  assert.match(text, /polluted by: writer/);
  assert.match(text, /reproduce: npx vitest run/);
});

test("wait-timeout: reproduce command loops until the first failure", () => {
  const r = buildReport(
    diagnosisFor({
      ...quiet,
      repeat: {
        verdict: "flaky",
        passes: 33,
        fails: 3,
        failRate: range(0.03, 0.22),
        passMedianMs: 200,
        failMedianMs: 1230,
      },
    }),
    "/proj",
  );
  assert.equal(r.findings[0].cause, "wait-timeout");
  assert.match(r.findings[0].reproduce ?? "", /for i in \$\(seq 30\)/);
});
