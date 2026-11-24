// Layer 3: find tests that fail only because of the ORDER tests run in.
//
// Vitest can shuffle the tests inside a file. A "seed" is a number that fixes
// the shuffle: the same seed always gives the same order.
// So a failure that appears with seed 3 can be reproduced on demand.

import { runOnce, unwrap, nameOfTestId } from "./run.ts";
import { decide } from "./stats.ts";

// Speed: runs with different seeds don't depend on each other, so we run
// CONCURRENCY of them at the same time. Measured on 8 cores: 1 run takes
// 1.2 s, 4 at once take 1.5 s (about 3x the throughput), 8 at once take 2.7 s.
// 4 is the sweet spot. This is safe here because an order failure depends on
// the seed, not on timing. (Do NOT do this for timing-flake detection:
// parallel runs compete for CPU and cause timing flakes of their own.)
const CONCURRENCY = 4;

// [1,2,3,4,5,6,7,8,9] in chunks of 4 -> [[1,2,3,4],[5,6,7,8],[9]]
function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

// Run one test file once, shuffled with one seed.
// Returns the ids of the tests that failed.
async function failedTestsForSeed(
  file: string,
  seed: number,
): Promise<string[]> {
  const shuffleArgs = ["--sequence.shuffle.tests", `--sequence.seed=${seed}`];
  const result = await runOnce([file], shuffleArgs);

  // unwrap throws on a crash or an empty run (a broken setup, not a result).
  const tests = unwrap(result);

  const failedIds: string[] = [];
  for (const test of tests) {
    if (test.status === "failed") {
      failedIds.push(test.id);
    }
  }
  return failedIds;
}

// "Run this file once with this seed, return the ids that failed."
// The default shuffles test order. Layer 4 passes in a different one that
// fixes Math.random instead, so scanSeeds and confirmSeed are reused as is.
export type SeedRunner = (file: string, seed: number) => Promise<string[]>;

// Try every seed in the list. Keep only the seeds where something failed.
// Result example: seed 3 -> ["...order.test.tsx::reader assumes empty cache"]
export async function scanSeeds(
  file: string,
  seeds: number[],
  runSeed: SeedRunner = failedTestsForSeed,
  // Optional: stop scanning after the first group of seeds in which this
  // test failed. We only need ONE failing seed for it, not all of them.
  stopWhenFailed?: string,
): Promise<Map<number, string[]>> {
  const failuresBySeed = new Map<number, string[]>();

  for (const group of chunk(seeds, CONCURRENCY)) {
    // Run the whole group at once. Promise.all keeps results in input order,
    // so seeds still go into the Map in increasing order.
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
  failures: number; // how many reruns the test failed in
  reruns: number;
};

// Rerun ONE seed and watch ONE test, until the evidence is strong.
//   One pass at this seed -> the seed does NOT decide the result: "random".
//     Stop at once. This is the cheap case.
//   Failing every time -> keep going until decide() says the fail rate is
//     above 80% (that takes 16 fails in a row): "order-dependent".
//
// Why not just 3 reruns? A random flake that fails 65% of the time fails 3 in
// a row about 27% of the time, so 3 reruns mislabeled `timing` as
// order-dependent. 16 in a row by luck: under 0.1%.
// Cost: a real order dependence needs 16 reruns. They run CONCURRENCY at a
// time (4 batches, about 6 seconds).
export async function confirmSeed(
  file: string,
  seed: number,
  testId: string,
  runSeed: SeedRunner = failedTestsForSeed,
): Promise<SeedConfirmation> {
  let failures = 0;
  let reruns = 0;

  // decide(0, failures) says "broken" once 16 fails in a row are seen.
  while (decide(0, failures) !== "broken") {
    // One batch of reruns, all at the same time.
    const batch = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => runSeed(file, seed)),
    );

    for (const failedIds of batch) {
      reruns++;
      if (!failedIds.includes(testId)) {
        // It passed at this seed, so the order alone does not explain it.
        return { verdict: "random", failures, reruns };
      }
      failures++;
    }
  }

  return { verdict: "order-dependent", failures, reruns };
}

// ---------- Layer 3b: find WHICH test pollutes the victim ----------
//
// Idea: run the victim together with a GROUP of other tests, shuffled with
// seeds 1..8. If the victim ever fails, the polluter is inside that group.
// Split the candidates in half, keep the half that fails, repeat.
//
// We cannot read the run order from Vitest's JSON (it lists tests in file
// order). We do not need to: with two tests, the polluter runs before the
// victim in about half of all seeds, and a failure proves it did.

// Test names can contain characters that mean something in a regex, like
// "." or "(". Put a backslash in front of each one. "$&" is the matched char.
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Names of every test in a file, from one normal (unshuffled) run.
async function listTestNames(file: string): Promise<string[]> {
  const tests = unwrap(await runOnce([file]));
  return tests.map((test) => nameOfTestId(test.id));
}

const PROBE_SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

// Run only the victim plus `others`, once per seed.
// true  = the victim failed under at least one seed
// false = it never failed. A group that holds the polluter is missed with
//         chance 0.5^8, about 0.4%.
async function probe(
  file: string,
  victim: string,
  others: string[],
): Promise<boolean> {
  // "^(a|b|c)$" means: exactly one of these names. No shell is involved, so
  // the pattern needs no quotes: execFile passes it as a single argument.
  const names = [victim, ...others].map(escapeRegex);
  const pattern = `^(${names.join("|")})$`;

  // Seeds run CONCURRENCY at a time. After each group, stop if the victim
  // failed, so a failing probe still skips the remaining groups.
  for (const group of chunk(PROBE_SEEDS, CONCURRENCY)) {
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

// Find the test(s) that make `victim` fail when they run before it.
// Usually returns ONE name. Returns several if the failure needs tests from
// both halves together.
export async function findPolluters(
  file: string,
  victim: string,
): Promise<string[]> {
  const names = await listTestNames(file);
  let candidates = names.filter((name) => name !== victim);

  // Check A: the victim alone must pass, or this is not an order problem.
  if (await probe(file, victim, [])) {
    throw new Error("victim fails on its own, so this is not an order problem");
  }
  // Check B: with every other test present, the failure must show up.
  if (!(await probe(file, victim, candidates))) {
    throw new Error("cannot reproduce the failure with these seeds");
  }

  while (candidates.length > 1) {
    const middle = Math.ceil(candidates.length / 2);
    const firstHalf = candidates.slice(0, middle);
    const secondHalf = candidates.slice(middle);

    if (await probe(file, victim, firstHalf)) {
      candidates = firstHalf;
    } else if (await probe(file, victim, secondHalf)) {
      candidates = secondHalf;
    } else {
      break; // neither half fails alone: the polluters work together
    }
  }

  return candidates;
}

// ---------- Layer 5 helper: the order check for ONE test ----------
//
// The `order` command in cli.ts checks every test in a file. diagnose needs
// the answer for one test, so this wraps the same steps:
// scan seeds -> confirm the first failing seed -> find the polluter.

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
): Promise<OrderProbeResult> {
  const seeds = Array.from({ length: seedsToTry }, (_, i) => i + 1);
  const failuresBySeed = await scanSeeds(file, seeds, undefined, testId);

  // First seed under which OUR test failed.
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

  const c = await confirmSeed(file, seed, testId);
  if (c.verdict !== "order-dependent") {
    return {
      verdict: "not-order-dependent",
      detail: `failed under seed ${seed}, then passed on a rerun`,
    };
  }

  // findPolluters throws if the test fails even when it runs alone. That is
  // not an order problem, so report it as such instead of crashing.
  try {
    const polluters = await findPolluters(file, nameOfTestId(testId));
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
