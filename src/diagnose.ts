import { runMany } from "./run.ts";
import { orderProbe, CONCURRENCY } from "./order.ts";
import { randomSeedProbe, loadProbe } from "./perturb.ts";
import { classify } from "./classify.ts";
import type { Evidence, Finding } from "./classify.ts";

export type Diagnosis = { testId: string; evidence: Evidence; findings: Finding[] };

export async function diagnose(file: string, testId: string): Promise<Diagnosis> {
  const summaries = await runMany(100, [file]);
  const summary = summaries.find((s) => s.id === testId);
  if (summary === undefined) {
    throw new Error(`No test with id ${testId}. Check the file and the test name.`);
  }

  const repeat: Evidence["repeat"] = {
    verdict: summary.verdict,
    passes: summary.passes,
    fails: summary.fails,
    failRate: summary.failRate,
    passMedianMs: summary.passMedianMs,
    failMedianMs: summary.failMedianMs,
  };

  // Never passes: classify() calls it a plain failure whatever the probes
  // find, so skip them.
  if (summary.verdict === "broken") {
    const evidence: Evidence = {
      repeat,
      scanConcurrency: 1,
      order: { verdict: "not-order-dependent" },
      random: { verdict: "inconclusive" },
      load: {
        verdict: "no-load-effect",
        alone: { low: 0, high: 1 },
        loaded: { low: 0, high: 1 },
      },
    };
    return { testId, evidence, findings: classify(evidence) };
  }

  // Sequential on purpose: parallel probes would add CPU load to each other.
  // The load probe goes FIRST. The repeat runs are its baseline.
  const load = await loadProbe(file, testId, {
    fails: summary.fails,
    runs: summary.passes + summary.fails,
  });

  // The order and Math.random scans run several copies at once, and that
  // alone makes a load-sensitive test fail. So for such a test, run them one
  // at a time (slower, but the failure then means what it says).
  const scanConcurrency = load.verdict === "load-sensitive" ? 1 : CONCURRENCY;
  const order = await orderProbe(file, testId, 20, scanConcurrency);
  const random = await randomSeedProbe(file, testId, 16, scanConcurrency);

  const evidence: Evidence = {
    repeat,
    scanConcurrency,
    order:
      order.verdict === "order-dependent"
        ? { verdict: "order-dependent", seed: order.seed, polluters: order.polluters }
        : { verdict: "not-order-dependent" },
    random:
      random.verdict === "random-driven"
        ? { verdict: "random-driven", seed: random.seed }
        : { verdict: random.verdict },
    load: {
      verdict: load.verdict,
      alone: load.alone.range,
      loaded: load.loaded.range,
    },
  };

  return { testId, evidence, findings: classify(evidence) };
}
