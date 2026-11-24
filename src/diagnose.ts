// Layer 5: run every earlier layer on ONE test, then let classify() judge.
//
//   repeat (Layer 2) + order (Layer 3) + Math.random and CPU load (Layer 4)
//     -> Evidence -> classify() -> Finding[]

import { runMany } from "./run.ts";
import { orderProbe } from "./order.ts";
import { randomSeedProbe, loadProbe } from "./perturb.ts";
import { classify } from "./classify.ts";
import type { Evidence, Finding } from "./classify.ts";

export type Diagnosis = { testId: string; evidence: Evidence; findings: Finding[] };

export async function diagnose(file: string, testId: string): Promise<Diagnosis> {
  // Layer 2, limited to this file so other files don't slow it down.
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

  // A test that never passes is a plain failure. classify() will say so
  // whatever the probes find, so don't spend minutes running them.
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

  // Layers 3 and 4. They run one after another: parallel probes would add
  // CPU load and disturb each other.
  const order = await orderProbe(file, testId);
  const random = await randomSeedProbe(file, testId);
  // The repeat runs already measured the test without extra load. Reuse them
  // as the load probe's baseline instead of running the test again.
  const load = await loadProbe(file, testId, {
    fails: summary.fails,
    runs: summary.passes + summary.fails,
  });

  // Translate each probe's full result into the small shape classify() wants.
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
