// Entry point. Four commands:
//
//   node src/cli.ts [maxRuns]          repeat the suite, stop early per test
//   node src/cli.ts order <test-file>  look for order dependence in one file
//   node src/cli.ts probe <test-file> "<test name>"
//                                      change one thing (Math.random, CPU load)
//                                      and see what the flake reacts to
//   node src/cli.ts diagnose <test-file> "<test name>" [--json]
//                                      run everything, print the likely cause
//                                      (--json: machine-readable, for agents)

import { resolve } from "node:path";
import { runMany, nameOfTestId } from "./run.ts";
import { scanSeeds, confirmSeed, findPolluters } from "./order.ts";
import { randomSeedProbe, loadProbe } from "./perturb.ts";
import { diagnose } from "./diagnose.ts";
import { buildReport, formatText } from "./report.ts";

const DEFAULT_MAX_RUNS = 100;
const SEEDS_TO_TRY = 20;

function formatPercent(fraction: number): string {
  const percent = fraction * 100;
  return `${percent.toFixed(0)}%`;
}

// ---------- command: repeat (Layers 1 and 2) ----------

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

  // "Fixed" means every test runs as many times as the busiest one.
  const fixedExecutions = busiestTestRuns * summaries.length;
  console.log(
    `\n${busiestTestRuns} runs, ${totalExecutions} test executions ` +
      `(fixed would be ${fixedExecutions}), ${seconds}s`,
  );
}

// ---------- command: order (Layer 3) ----------

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

  // For each failing test, remember the FIRST seed that made it fail.
  // (Map keeps insertion order and seeds were added in increasing order.)
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

    // Only a confirmed order dependence has a polluter worth searching for.
    if (confirmation.verdict === "order-dependent") {
      const polluters = await findPolluters(file, nameOfTestId(id));
      const note = polluters.length > 1 ? "  (needs several together)" : "";
      console.log(`  polluted by: ${polluters.join(", ")}${note}`);
    }
  }
}

// ---------- command: probe (Layer 4) ----------

async function probeCommand(
  fileArg: string | undefined,
  testName: string | undefined,
): Promise<void> {
  if (fileArg === undefined || testName === undefined) {
    console.log('Usage: node src/cli.ts probe <test-file> "<test name>"');
    return;
  }
  // Test ids look like "<absolute file path>::<test name>".
  const file = resolve(fileArg);
  const testId = `${file}::${testName}`;

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

// ---------- command: diagnose (Layer 5) ----------

// args: <test-file> "<test name>" [--json]
//   --json  print ONLY a JSON report on stdout, for agents and CI.
// Exit code: 0 = no problem found, 1 = a problem was found.
async function diagnoseCommand(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const [fileArg, testName] = args.filter((arg) => arg !== "--json");

  if (fileArg === undefined || testName === undefined) {
    console.log('Usage: node src/cli.ts diagnose <test-file> "<test name>" [--json]');
    return;
  }
  const file = resolve(fileArg);
  const diagnosis = await diagnose(file, `${file}::${testName}`);
  const report = buildReport(diagnosis, process.cwd());

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\n${formatText(report)}`);
  }

  // A CI job can fail on this: `node src/cli.ts diagnose ... || echo flaky`.
  process.exitCode = report.hasProblem ? 1 : 0;
}

// ---------- pick the command ----------

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
