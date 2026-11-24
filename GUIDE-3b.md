# Guide 3b: find the polluter (bisection)

Goal: Layer 3a says "`victim` fails under seed 3". This layer says
"`victim` fails because `polluter: logs in` ran before it".

I added a new fixture for this: `fixtures/pollution.test.tsx`. It has 8 tests.
One is the victim, one is the polluter, six are innocent. With only the 2-test
`order` file, finding the polluter would be trivial.

## The idea in 5 lines

1. Take the victim plus a **group** of other tests. Run just those, with
   seeds 1..8.
2. If the victim ever fails, the polluter is in that group.
3. If it never fails, the polluter is not in that group.
4. Split the candidates in half. Test one half. Keep the half that fails.
5. Repeat until one candidate is left. 8 tests take about 3 rounds, not 7.

Why this works without knowing the run order: with 2 tests, the polluter runs
before the victim in about half of all seeds. A failure proves it did.
(Vitest's JSON lists tests in file order, not run order, so we can't read it.)

## Step 0: see it by hand (3 minutes)

The victim passes in file order:

    pnpm exec vitest run fixtures/pollution.test.tsx

Now run only the victim and the polluter, shuffled. `-t` is a regex on the
test name. `^(a|b)$` means "exactly a or exactly b" (without `^` and `$`,
one name can match inside a longer one):

    pnpm exec vitest run fixtures/pollution.test.tsx \
      -t "^(pollution: victim expects a logged-out session|pollution: polluter logs in)$" \
      --sequence.shuffle.tests --sequence.seed=5

Verified: seeds 5 and 6 fail the victim; seeds 1 to 4 pass. Swap the polluter
for `pollution: innocent a changes the theme`: **no seed ever fails**.
That difference is the whole signal.

## Step 1: `escapeRegex` (add to `src/order.ts`)

Test names contain characters that mean something in a regex (`.`, `(`, `+`).
Escape them before building the pattern:

    function escapeRegex(text: string): string {
      return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

`$&` in the replacement means "the matched character". Each special character
gets a backslash in front.

Checkpoint: `escapeRegex("a.b(c)")` gives `a\.b\(c\)`.

## Step 2: `listTestNames(file)`

    async function listTestNames(file: string): Promise<string[]>

One normal run (`runOnce([file])`, then `unwrap`), then
`nameOfTestId(id)` for each test.

Checkpoint: for `pollution.test.tsx` you get 8 names.

## Step 3: `probe`

    async function probe(
      file: string,
      victim: string,
      others: string[],
      seeds: number[] = [1, 2, 3, 4, 5, 6, 7, 8],
    ): Promise<boolean>

Returns `true` if the victim failed under any seed.

For each seed:
1. Build `pattern = "^(" + [victim, ...others].map(escapeRegex).join("|") + ")$"`
2. Call `runOnce([file], ["-t", pattern, "--sequence.shuffle.tests", `--sequence.seed=${seed}`])`
3. `unwrap` it. If the test named `victim` has status `"failed"`, return `true` now
   (stop early, don't waste runs).

After all seeds, return `false`.

Gotcha: in a terminal you wrap the pattern in quotes. Here you don't.
`execFile` passes each array item as one argument with no shell, so the
pattern goes in as-is.

Checkpoint (these are the three calls to try):

    probe(file, victim, [polluter])        -> true
    probe(file, victim, [innocent a])      -> false
    probe(file, victim, [])                -> false   (victim alone never fails)

Accuracy: a group that contains the polluter is missed with chance
0.5^8 = 0.4%. Fine for now.

## Step 4: `findPolluters` (the bisection)

    export async function findPolluters(
      file: string,
      victim: string,
    ): Promise<string[]>

1. `candidates` = every test name in the file except the victim.
2. Sanity check A: `probe(file, victim, [])` must be `false`.
   If it is `true`, throw: "victim fails on its own, not an order problem".
3. Sanity check B: `probe(file, victim, candidates)` must be `true`.
   If not, throw: "cannot reproduce".
4. While `candidates.length > 1`:
   - `mid = Math.ceil(candidates.length / 2)`
   - `first = candidates.slice(0, mid)`, `second = candidates.slice(mid)`
   - if `probe(file, victim, first)` -> `candidates = first`
   - else if `probe(file, victim, second)` -> `candidates = second`
   - else `break` (the failure needs tests from both halves together)
5. Return `candidates`.

Checkpoint (verified):

    pollution.test.tsx -> ["pollution: polluter logs in"]
        7 probes, 44 vitest runs, 54 seconds
    order.test.tsx     -> ["order: writer populates cache"]
        2 probes, 11 vitest runs, 14 seconds

Why so many runs: a probe that finds nothing must try all 8 seeds. That is
the slow part. It is the first thing to speed up later.

## Step 5: show it in the CLI

In `cli.ts`, inside the `order` command, after a test is confirmed
`order-dependent`, call `findPolluters(file, nameOfTestId(id))` and print:

    order-dependent  pollution: victim expects a logged-out session  (seed 5, fails 16/16)
      polluted by: pollution: polluter logs in

If `findPolluters` returns more than one name, print them all and add
"(needs several together)".

Run: `node src/cli.ts order fixtures/pollution.test.tsx`
(about 1.5 minutes: scan, confirm, bisect)

## Known limits (write these in your README later)

- One probe can miss a real polluter, 0.4% of the time.
- If two tests only pollute together, you get both back, not one.
- It finds tests in the **same file**. Pollution across files needs a
  different method.

## Done when

`node src/cli.ts order fixtures/pollution.test.tsx` names the polluter.
Paste your new code in `order.ts` and `cli.ts`.
