import { existsSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runOnce, unwrap } from "./run.ts";
import { scanSeeds, confirmSeed, CONCURRENCY } from "./order.ts";
import { wilson } from "./stats.ts";
import type { Interval } from "./stats.ts";

// ---------- probe 1: fixed Math.random ----------
//
// A setup file (src/probes/random-setup.ts) replaces Math.random when
// FLAKESCOPE_RANDOM_SEED is set. Vitest has no CLI flag for setup files, so we
// write a small config that extends the project's own config and adds it.

// The setup file lives next to this tool, NOT in the project being tested.
const SETUP_FILE = fileURLToPath(new URL("./probes/random-setup.ts", import.meta.url));

// The project's own config: vitest.config.* first, then vite.config.*.
function findBaseConfig(): string {
  const names = ["vitest.config", "vite.config"];
  const extensions = ["ts", "mts", "cts", "js", "mjs", "cjs"];
  for (const name of names) {
    for (const ext of extensions) {
      const path = resolve(`${name}.${ext}`);
      if (existsSync(path)) return path;
    }
  }
  throw new Error("No vitest.config.* or vite.config.* in this folder.");
}

// Everything the probe needs goes INSIDE the project's .flakescope folder:
//  - `import "vitest/config"` only finds node_modules from inside the project;
//  - Vite refuses to serve files from outside the project root, so the setup
//    file is copied in (found out the hard way on a real project).
// The config is .mts so Node reads it as ES modules whatever the project's
// package.json says.
async function writeRandomConfig(): Promise<string> {
  const dir = resolve(".flakescope");
  await mkdir(dir, { recursive: true });

  const setupFile = join(dir, "random-setup.ts");
  await copyFile(SETUP_FILE, setupFile);

  const configPath = join(dir, "random.config.mts");
  // A project's config may export an object or a function. Handle both.
  const source = `
import { defineConfig, mergeConfig } from "vitest/config";
import base from ${JSON.stringify(findBaseConfig())};

export default defineConfig(async (env) => {
  const resolved = typeof base === "function" ? await base(env) : base;
  return mergeConfig(resolved, {
    root: ${JSON.stringify(process.cwd())},
    test: { setupFiles: [${JSON.stringify(setupFile)}] },
  });
});
`;
  await writeFile(configPath, source);
  return configPath;
}

export type RandomProbeResult =
  | { verdict: "random-driven"; seed: number; failures: number; reruns: number }
  | { verdict: "not-random-driven"; seed: number; failures: number; reruns: number }
  | { verdict: "inconclusive"; seedsTried: number };

export async function randomSeedProbe(
  file: string,
  testId: string,
  seedsToTry = 16,
  concurrency: number = CONCURRENCY,
): Promise<RandomProbeResult> {
  const configPath = await writeRandomConfig();

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
  const failuresBySeed = await scanSeeds(file, seeds, runWithRandomSeed, testId, concurrency);

  let failingSeed: number | undefined;
  for (const [seed, ids] of failuresBySeed) {
    if (ids.includes(testId)) {
      failingSeed = seed;
      break;
    }
  }

  // Math.random may still be the cause (failing values can be rare), but we
  // cannot show it.
  if (failingSeed === undefined) {
    return { verdict: "inconclusive", seedsTried: seedsToTry };
  }

  // confirmSeed's "order-dependent" means "this seed fails every time".
  const c = await confirmSeed(
    file,
    failingSeed,
    testId,
    runWithRandomSeed,
    concurrency,
  );
  return {
    verdict: c.verdict === "order-dependent" ? "random-driven" : "not-random-driven",
    seed: failingSeed,
    failures: c.failures,
    reruns: c.reruns,
  };
}

// ---------- probe 2: CPU load ----------
//
// Run the file alone (baseline), then many copies at once so they compete for
// the CPU, as in CI. Load-sensitive if the loaded range sits above the
// baseline range.

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

// known: earlier runs without extra load, reused as the baseline. Topped up
// with fresh runs if fewer than BASELINE_RUNS.
export async function loadProbe(
  file: string,
  testId: string,
  known: { fails: number; runs: number } = { fails: 0, runs: 0 },
): Promise<LoadProbeResult> {
  let aloneFails = known.fails;
  let aloneRuns = known.runs;
  while (aloneRuns < BASELINE_RUNS) {
    if (await didFail(file, testId)) aloneFails++;
    aloneRuns++;
  }

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
    verdict: loadedRange.low > aloneRange.high ? "load-sensitive" : "no-load-effect",
    alone: { fails: aloneFails, runs: aloneRuns, range: aloneRange },
    loaded: { fails: loadedFails, runs: loadedRuns, range: loadedRange },
  };
}
