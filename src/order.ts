import { runOnce, unwrap, nameOfTestId } from "./run.ts";
import { decide } from "./stats.ts";

// Parallel runs are safe here: an order failure depends on the seed, not on
// timing. Do not do this for timing-flake detection (CPU contention).
// Measured on 8 cores: 4 at once is about 3x the throughput of 1.
// A test that is sensitive to CPU load must be checked with 1 (see diagnose.ts).
export const CONCURRENCY = 4;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

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

// Runs one file once with one seed, returns the ids that failed.
// perturb.ts passes a different runner that fixes Math.random instead.
export type SeedRunner = (file: string, seed: number) => Promise<string[]>;

// Returns only the seeds under which something failed.
// stopWhenFailed: stop after the first group of seeds where this test failed.
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

// Reruns one seed until the evidence is strong.
// One pass -> "random". 16 fails in a row -> "order-dependent".
// Why 16: with only 3 reruns, a flake failing 65% of the time was mislabeled
// order-dependent about 27% of the time. 16 in a row by luck is under 0.1%.
export async function confirmSeed(
  file: string,
  seed: number,
  testId: string,
  runSeed: SeedRunner = failedTestsForSeed,
  concurrency: number = CONCURRENCY,
): Promise<SeedConfirmation> {
  let failures = 0;
  let reruns = 0;

  // decide(0, failures) returns "broken" after 16 fails in a row.
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

// ---------- find WHICH test pollutes the victim ----------
//
// Vitest's JSON lists tests in file order, not run order, so the polluter
// can't be read from a failing run. Instead: run the victim with a group of
// others under seeds 1..8, and bisect the group. Any one polluter lands
// before the victim in about half of all seeds.

// "." and "(" in a test name mean something in a regex; "$&" is the match.
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function listTestNames(file: string): Promise<string[]> {
  const tests = unwrap(await runOnce([file]));
  return tests.map((test) => nameOfTestId(test.id));
}

const PROBE_SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

// true if the victim failed under any seed. A group holding the polluter is
// missed with chance 0.5^8, about 0.4%.
async function probe(
  file: string,
  victim: string,
  others: string[],
  concurrency: number,
): Promise<boolean> {
  // execFile passes the pattern as one argument, so no shell quoting.
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

// Usually returns one name. Returns several if the failure needs tests from
// both halves together.
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
      break; // neither half fails alone: the polluters work together
    }
  }

  return candidates;
}

// ---------- order check for ONE test (used by diagnose) ----------

export type OrderProbeResult =
  | {
      verdict: "order-dependent";
      seed: number;
      failures: number;
      reruns: number;
      polluters: string[];
    }
  | { verdict: "not-order-dependent"; detail: string };

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

  // findPolluters throws when the test fails even alone: not an order problem.
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
