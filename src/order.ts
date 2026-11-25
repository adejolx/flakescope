import { runOnce, unwrap, nameOfTestId } from "./run.ts";
import { decide } from "./stats.ts";

export const CONCURRENCY = 4;

/**
 * Rejects a concurrency that would make the scans loop forever.
 * @param concurrency - Number of runs at once.
 * @throws RangeError unless it is a positive integer.
 */
function requireConcurrency(concurrency: number): void {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`concurrency must be a positive integer, got ${concurrency}`);
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  requireConcurrency(size);
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Runs a file once under a shuffle seed.
 * @param file - Test file.
 * @param seed - Shuffle seed.
 * @returns Ids of the tests that failed.
 */
async function failedTestsForSeed(
  file: string,
  seed: number,
): Promise<string[]> {
  const shuffleArgs = ["--sequence.shuffle.tests", `--sequence.seed=${seed}`];
  const tests = unwrap(await runOnce([file], shuffleArgs));

  const failedIds: string[] = [];
  for (const test of tests) {
    if (test.status === "failed") {
      failedIds.push(test.id);
    }
  }
  return failedIds;
}

export type SeedRunner = (file: string, seed: number) => Promise<string[]>;

/**
 * Runs a file under many seeds, several at a time.
 * @param file - Test file.
 * @param seeds - Seeds to try, in order.
 * @param runSeed - Runner for one seed; defaults to a shuffle run.
 * @param stopWhenFailed - Test id; scanning stops after the first group of seeds in which it failed.
 * @param concurrency - Seeds run at once; a positive integer.
 * @returns Map from seed to failed test ids, holding only seeds with a failure.
 * @throws RangeError if concurrency is not a positive integer.
 */
export async function scanSeeds(
  file: string,
  seeds: number[],
  runSeed: SeedRunner = failedTestsForSeed,
  stopWhenFailed?: string,
  concurrency: number = CONCURRENCY,
): Promise<Map<number, string[]>> {
  const failuresBySeed = new Map<number, string[]>();

  for (const group of chunk(seeds, concurrency)) {
    const results = await Promise.all(
      group.map((seed) => runSeed(file, seed)),
    );

    for (let i = 0; i < group.length; i++) {
      if (results[i].length > 0) {
        failuresBySeed.set(group[i], results[i]);
      }
    }

    if (
      stopWhenFailed !== undefined &&
      results.some((failedIds) => failedIds.includes(stopWhenFailed))
    ) {
      break;
    }
  }

  return failuresBySeed;
}

export type SeedVerdict = "order-dependent" | "random";

export type SeedConfirmation = {
  verdict: SeedVerdict;
  failures: number;
  reruns: number;
};

/**
 * Reruns one seed until the evidence is strong. One pass means "random";
 * enough consecutive fails (see decide()) means "order-dependent".
 * @param file - Test file.
 * @param seed - Seed to rerun.
 * @param testId - Test that failed under the seed.
 * @param runSeed - Runner for one seed.
 * @param concurrency - Reruns per batch.
 * @returns The verdict with the failure and rerun counts.
 * @throws RangeError if concurrency is not a positive integer.
 */
export async function confirmSeed(
  file: string,
  seed: number,
  testId: string,
  runSeed: SeedRunner = failedTestsForSeed,
  concurrency: number = CONCURRENCY,
): Promise<SeedConfirmation> {
  requireConcurrency(concurrency);
  let failures = 0;
  let reruns = 0;

  while (decide(0, failures) !== "broken") {
    const batch = await Promise.all(
      Array.from({ length: concurrency }, () => runSeed(file, seed)),
    );

    for (const failedIds of batch) {
      reruns++;
      if (!failedIds.includes(testId)) {
        return { verdict: "random", failures, reruns };
      }
      failures++;
    }
  }

  return { verdict: "order-dependent", failures, reruns };
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function listTestNames(file: string): Promise<string[]> {
  const tests = unwrap(await runOnce([file]));
  return tests.map((test) => nameOfTestId(test.id));
}

const PROBE_SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

/**
 * Checks whether a victim test fails under any of the probe seeds when run
 * with a given group of other tests.
 * @param file - Test file.
 * @param victim - Name of the victim test.
 * @param others - Names of the other tests to include.
 * @param concurrency - Seeds run at once.
 * @returns True if the victim failed under any seed.
 */
async function probe(
  file: string,
  victim: string,
  others: string[],
  concurrency: number,
): Promise<boolean> {

  const names = [victim, ...others].map(escapeRegex);
  const pattern = `^(${names.join("|")})$`;

  for (const group of chunk(PROBE_SEEDS, concurrency)) {
    const results = await Promise.all(
      group.map(async (seed) => {
        const args = [
          "-t",
          pattern,
          "--sequence.shuffle.tests",
          `--sequence.seed=${seed}`,
        ];
        return unwrap(await runOnce([file], args));
      }),
    );

    for (const tests of results) {
      for (const test of tests) {
        if (nameOfTestId(test.id) === victim && test.status === "failed") {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Finds which test pollutes a victim by bisecting the other tests.
 * Returns several names if the failure needs tests from both halves together.
 * @param file - Test file.
 * @param victim - Name of the failing test.
 * @param concurrency - Seeds run at once.
 * @returns The polluting test names.
 * @throws If the victim fails alone, or the failure cannot be reproduced.
 */
export async function findPolluters(
  file: string,
  victim: string,
  concurrency: number = CONCURRENCY,
): Promise<string[]> {
  const names = await listTestNames(file);
  let candidates = names.filter((name) => name !== victim);

  if (await probe(file, victim, [], concurrency)) {
    throw new Error("victim fails on its own, so this is not an order problem");
  }
  if (!(await probe(file, victim, candidates, concurrency))) {
    throw new Error("cannot reproduce the failure with these seeds");
  }

  while (candidates.length > 1) {
    const middle = Math.ceil(candidates.length / 2);
    const firstHalf = candidates.slice(0, middle);
    const secondHalf = candidates.slice(middle);

    if (await probe(file, victim, firstHalf, concurrency)) {
      candidates = firstHalf;
    } else if (await probe(file, victim, secondHalf, concurrency)) {
      candidates = secondHalf;
    } else {
      break;
    }
  }

  return candidates;
}

export type OrderProbeResult =
  | {
      verdict: "order-dependent";
      seed: number;
      failures: number;
      reruns: number;
      polluters: string[];
    }
  | { verdict: "not-order-dependent"; detail: string };

/**
 * Checks one test for order dependence: scans seeds, confirms the failing
 * seed, then locates the polluters.
 * @param file - Test file.
 * @param testId - Test to check.
 * @param seedsToTry - Number of seeds to scan.
 * @param concurrency - Seeds run at once.
 * @returns The verdict, with seed and polluters when order-dependent.
 */
export async function orderProbe(
  file: string,
  testId: string,
  seedsToTry = 20,
  concurrency: number = CONCURRENCY,
): Promise<OrderProbeResult> {
  const seeds = Array.from({ length: seedsToTry }, (_, i) => i + 1);
  const failuresBySeed = await scanSeeds(file, seeds, undefined, testId, concurrency);

  let seed: number | undefined;
  for (const [s, ids] of failuresBySeed) {
    if (ids.includes(testId)) {
      seed = s;
      break;
    }
  }
  if (seed === undefined) {
    return {
      verdict: "not-order-dependent",
      detail: `no failure in ${seedsToTry} shuffled runs`,
    };
  }

  const c = await confirmSeed(file, seed, testId, undefined, concurrency);
  if (c.verdict !== "order-dependent") {
    return {
      verdict: "not-order-dependent",
      detail: `failed under seed ${seed}, then passed on a rerun`,
    };
  }

  try {
    const polluters = await findPolluters(file, nameOfTestId(testId), concurrency);
    return {
      verdict: "order-dependent",
      seed,
      failures: c.failures,
      reruns: c.reruns,
      polluters,
    };
  } catch (e) {
    return {
      verdict: "not-order-dependent",
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}
