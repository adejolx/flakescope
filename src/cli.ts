import { resolve } from "node:path";
import { runMany, nameOfTestId, makeTestId } from "./run.ts";
import { scanSeeds, confirmSeed, findPolluters } from "./order.ts";
import { randomSeedProbe, loadProbe } from "./perturb.ts";
import { formatPercent } from "./stats.ts";
import { diagnose } from "./diagnose.ts";
import { buildReport, formatText } from "./report.ts";

const DEFAULT_MAX_RUNS = 100;
const SEEDS_TO_TRY = 20;

/**
 * Repeats the whole suite and prints a verdict per test plus a run-count summary.
 * @param maxRunsArg - Optional maximum number of runs; non-positive or missing uses the default.
 */
async function repeatCommand(maxRunsArg: string | undefined): Promise<void> {
  let maxRuns = DEFAULT_MAX_RUNS;
  if (maxRunsArg !== undefined && Number(maxRunsArg) > 0) {
    maxRuns = Number(maxRunsArg);
  }

  const startTime = performance.now();
  const summaries = await runMany(maxRuns);
  const seconds = ((performance.now() - startTime) / 1000).toFixed(1);

  let totalExecutions = 0;
  let busiestTestRuns = 0;

  for (const s of summaries) {
    const runs = s.passes + s.fails;
    totalExecutions += runs;
    if (runs > busiestTestRuns) {
      busiestTestRuns = runs;
    }

    const low = formatPercent(s.failRate.low);
    const high = formatPercent(s.failRate.high);
    console.log(
      `${s.verdict.padEnd(9)} ${s.passes}/${runs}  fail rate ${low}..${high}  ${s.id}`,
    );
  }

  const fixedExecutions = busiestTestRuns * summaries.length;
  console.log(
    `\n${busiestTestRuns} runs, ${totalExecutions} test executions ` +
      `(fixed would be ${fixedExecutions}), ${seconds}s`,
  );
}

/**
 * Scans a file for order dependence and prints each failing test with its polluters.
 * @param file - Test file; prints usage when missing.
 */
async function orderCommand(file: string | undefined): Promise<void> {
  if (file === undefined) {
    console.log("Usage: node src/cli.ts order <test-file>");
    return;
  }

  const seeds: number[] = [];
  for (let seed = 1; seed <= SEEDS_TO_TRY; seed++) {
    seeds.push(seed);
  }

  const failuresBySeed = await scanSeeds(file, seeds);

  const firstSeedByTest = new Map<string, number>();
  for (const [seed, failedIds] of failuresBySeed) {
    for (const id of failedIds) {
      if (!firstSeedByTest.has(id)) {
        firstSeedByTest.set(id, seed);
      }
    }
  }

  if (firstSeedByTest.size === 0) {
    console.log(`no order dependence found in ${SEEDS_TO_TRY} seeds`);
    return;
  }

  for (const [id, seed] of firstSeedByTest) {
    const confirmation = await confirmSeed(file, seed, id);
    console.log(
      `${confirmation.verdict.padEnd(16)} ${nameOfTestId(id)}  ` +
        `(seed ${seed}, fails ${confirmation.failures}/${confirmation.reruns})`,
    );

    if (confirmation.verdict === "order-dependent") {
      const polluters = await findPolluters(file, nameOfTestId(id));
      const note = polluters.length > 1 ? "  (needs several together)" : "";
      console.log(`  polluted by: ${polluters.join(", ")}${note}`);
    }
  }
}

/**
 * Runs the Math.random and CPU-load probes on one test and prints the results.
 * @param fileArg - Test file path.
 * @param testName - Full test name.
 */
async function probeCommand(
  fileArg: string | undefined,
  testName: string | undefined,
): Promise<void> {
  if (fileArg === undefined || testName === undefined) {
    console.log('Usage: node src/cli.ts probe <test-file> "<test name>"');
    return;
  }
  const file = resolve(fileArg);
  const testId = makeTestId(file, testName);

  console.log(`probing: ${testName}\n`);

  const random = await randomSeedProbe(file, testId);
  if (random.verdict === "inconclusive") {
    console.log(
      `Math.random   inconclusive: no failure under ${random.seedsTried} fixed seeds`,
    );
  } else if (random.verdict === "random-driven") {
    console.log(
      `Math.random   DRIVES the flake  (seed ${random.seed}, fails ${random.failures}/${random.reruns})`,
    );
  } else {
    console.log(
      `Math.random   not the cause  (seed ${random.seed} failed, then passed on a rerun)`,
    );
  }

  const load = await loadProbe(file, testId);
  const alone = `${load.alone.fails}/${load.alone.runs}`;
  const loaded = `${load.loaded.fails}/${load.loaded.runs}`;
  const aloneRange = `${formatPercent(load.alone.range.low)}..${formatPercent(load.alone.range.high)}`;
  const loadedRange = `${formatPercent(load.loaded.range.low)}..${formatPercent(load.loaded.range.high)}`;
  const label =
    load.verdict === "load-sensitive" ? "DRIVEN by CPU load" : "no load effect";
  console.log(
    `CPU load      ${label}  (alone ${alone} fails, ${aloneRange}; loaded ${loaded} fails, ${loadedRange})`,
  );
}

/**
 * Diagnoses one test and prints a text or JSON report. Sets exit code 1 when a problem was found.
 * @param args - File, test name and an optional --json flag.
 */
async function diagnoseCommand(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const [fileArg, testName] = args.filter((arg) => arg !== "--json");

  if (fileArg === undefined || testName === undefined) {
    console.log('Usage: node src/cli.ts diagnose <test-file> "<test name>" [--json]');
    return;
  }
  const file = resolve(fileArg);
  const diagnosis = await diagnose(file, makeTestId(file, testName));
  const report = buildReport(diagnosis, process.cwd());

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\n${formatText(report)}`);
  }

  process.exitCode = report.hasProblem ? 1 : 0;
}

const command = process.argv[2];

if (command === "order") {
  await orderCommand(process.argv[3]);
} else if (command === "probe") {
  await probeCommand(process.argv[3], process.argv[4]);
} else if (command === "diagnose") {
  await diagnoseCommand(process.argv.slice(3));
} else {
  await repeatCommand(command);
}
