import { runMany } from "./run.ts";
import { orderProbe } from "./order.ts";
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
  };

  // Never passes: classify() calls it a plain failure whatever the probes
  // find, so skip them.
  if (summary.verdict === "broken") {
    const evidence: Evidence = {
      repeat,
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
  const order = await orderProbe(file, testId);
  const random = await randomSeedProbe(file, testId);
  // The repeat runs are the load probe's baseline.
  const load = await loadProbe(file, testId, {
    fails: summary.fails,
    runs: summary.passes + summary.fails,
  });

  const evidence: Evidence = {
    repeat,
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
