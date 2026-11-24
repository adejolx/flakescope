// Layer 4: change ONE thing about how a flaky test runs, then see if the
// flake reacts. A test that reacts to a change tells us its cause.
//
//   probe 1: fix Math.random      -> does the flake become predictable?
//   probe 2: put the CPU under load -> does the fail rate jump?

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runOnce, unwrap } from "./run.ts";
import { scanSeeds, confirmSeed } from "./order.ts";
import { wilson } from "./stats.ts";
import type { Interval } from "./stats.ts";

// ---------- probe 1: fixed Math.random ----------
//
// Same idea as Layer 3. There a seed fixed the test ORDER. Here a seed fixes
// Math.random. If the test fails every time under one seed, and passes under
// other seeds, then Math.random decides the result.
//
// How we change Math.random without touching the test: Vitest runs a "setup
// file" before every test file. Ours (src/probes/random-setup.ts) replaces
// Math.random when the env var FLAKESCOPE_RANDOM_SEED is set.
// A setup file is part of the config, and there is no command line flag for
// it. So we write a tiny config that extends the project's own config and
// adds our setup file.

const SETUP_FILE = resolve("src/probes/random-setup.ts");
const BASE_CONFIG = resolve("vitest.config.ts");

// Writes .flakescope/random.config.ts and returns its path. It lives inside
// the project so that `import "vitest/config"` can find node_modules.
async function writeRandomConfig(): Promise<string> {
  const dir = resolve(".flakescope");
  await mkdir(dir, { recursive: true });

  const configPath = join(dir, "random.config.ts");
  const source = `
import { mergeConfig } from "vitest/config";
import base from ${JSON.stringify(BASE_CONFIG)};

export default mergeConfig(base, {
  root: ${JSON.stringify(process.cwd())},
  test: { setupFiles: [${JSON.stringify(SETUP_FILE)}] },
});
`;
  await writeFile(configPath, source);
  return configPath;
}

export type RandomProbeResult =
  | { verdict: "random-driven"; seed: number; failures: number; reruns: number }
  | { verdict: "not-random-driven"; seed: number; failures: number; reruns: number }
  | { verdict: "inconclusive"; seedsTried: number };

// Is Math.random the cause of this flake?
export async function randomSeedProbe(
  file: string,
  testId: string,
  seedsToTry = 16,
): Promise<RandomProbeResult> {
  const configPath = await writeRandomConfig();

  // The SeedRunner for this probe: fix Math.random instead of the order.
  const runWithRandomSeed = async (f: string, seed: number) => {
    const result = await runOnce(
      [f],
      [`--config=${configPath}`],
      { FLAKESCOPE_RANDOM_SEED: String(seed) },
    );
    return unwrap(result)
      .filter((t) => t.status === "failed")
      .map((t) => t.id);
  };

  const seeds = Array.from({ length: seedsToTry }, (_, i) => i + 1);
  const failuresBySeed = await scanSeeds(file, seeds, runWithRandomSeed, testId);

  // Find the first seed under which OUR test failed.
  let failingSeed: number | undefined;
  for (const [seed, ids] of failuresBySeed) {
    if (ids.includes(testId)) {
      failingSeed = seed;
      break;
    }
  }

  // It never failed under any of these seeds. Math.random may still be the
  // cause (the failing numbers can be rare), but we cannot show it.
  if (failingSeed === undefined) {
    return { verdict: "inconclusive", seedsTried: seedsToTry };
  }

  // Rerun that seed. confirmSeed's "order-dependent" just means "this seed
  // makes it fail every time". Here that means Math.random is the cause.
  const c = await confirmSeed(file, failingSeed, testId, runWithRandomSeed);
  return {
    verdict: c.verdict === "order-dependent" ? "random-driven" : "not-random-driven",
    seed: failingSeed,
    failures: c.failures,
    reruns: c.reruns,
  };
}

// ---------- probe 2: CPU load ----------
//
// Run the test file alone a few times (baseline), then run many copies at the
// same time (that is the load: the copies compete for the CPU, which is what
// happens in CI). Compare the fail-rate ranges from Layer 2's wilson().
// If the loaded range sits completely above the baseline range, the test is
// sensitive to load.

const BASELINE_RUNS = 6;
const LOAD_COPIES = 8; // one per core on this machine
const LOAD_ROUNDS = 2;

async function didFail(file: string, testId: string): Promise<boolean> {
  const tests = unwrap(await runOnce([file]));
  return tests.some((t) => t.id === testId && t.status === "failed");
}

export type LoadProbeResult = {
  verdict: "load-sensitive" | "no-load-effect";
  alone: { fails: number; runs: number; range: Interval };
  loaded: { fails: number; runs: number; range: Interval };
};

// `known`: results from runs we already did without extra load (Layer 2's
// repeat runs). Reusing them saves the baseline runs, and for a clean test
// (35 runs) it gives a tighter range than 6 fresh runs would. If there are
// fewer than BASELINE_RUNS, we top up with fresh ones.
export async function loadProbe(
  file: string,
  testId: string,
  known: { fails: number; runs: number } = { fails: 0, runs: 0 },
): Promise<LoadProbeResult> {
  // Baseline: one run at a time, so nothing competes for the CPU.
  let aloneFails = known.fails;
  let aloneRuns = known.runs;
  while (aloneRuns < BASELINE_RUNS) {
    if (await didFail(file, testId)) aloneFails++;
    aloneRuns++;
  }

  // Load: LOAD_COPIES runs at the same time, repeated LOAD_ROUNDS times.
  let loadedFails = 0;
  for (let round = 0; round < LOAD_ROUNDS; round++) {
    const results = await Promise.all(
      Array.from({ length: LOAD_COPIES }, () => didFail(file, testId)),
    );
    loadedFails += results.filter((failed) => failed).length;
  }
  const loadedRuns = LOAD_COPIES * LOAD_ROUNDS;

  const aloneRange = wilson(aloneFails, aloneRuns);
  const loadedRange = wilson(loadedFails, loadedRuns);

  return {
    // The two ranges do not overlap, and loaded is the higher one.
    verdict: loadedRange.low > aloneRange.high ? "load-sensitive" : "no-load-effect",
    alone: { fails: aloneFails, runs: aloneRuns, range: aloneRange },
    loaded: { fails: loadedFails, runs: loadedRuns, range: loadedRange },
  };
}
