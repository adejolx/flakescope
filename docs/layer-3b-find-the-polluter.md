# Layer 3b: find the polluting test

**One line:** once a test is proven order-dependent, find which other test breaks it.

Code: `findPolluters` and `probe` in [`src/order.ts`](../src/order.ts)

## Why this layer exists

Layer 3 says "`reader` fails when the order changes". That is not enough to
fix it. You need the name of the test that runs before it and leaves state behind.

Vitest's JSON report lists tests in file order, not execution order, so you
cannot read the polluter off a failing run.

## The idea: bisect

Run the victim with a *group* of other tests, shuffled with seeds 1..8.

- Victim fails in some seed: the polluter is in the group.
- Victim never fails: the polluter is not in the group.

Then halve the group and repeat.

## Steps in `findPolluters(file, victim)`

1. List every test name in the file (one normal run).
2. **Check A:** victim alone must pass. If it fails alone, this is not an order problem. Throws.
3. **Check B:** victim with all others must fail. If not, the seeds cannot reproduce it. Throws.
4. Split candidates in two. Probe the first half, then the second.
5. Keep the half that makes the victim fail. Repeat until one is left.
6. If neither half fails alone, stop: the polluters need each other. Return all remaining.

## `probe(file, victim, others)`

Runs `vitest -t "^(victim|other1|other2)$" --sequence.shuffle.tests --sequence.seed=N`
for each seed. Returns `true` as soon as the victim fails.

- Names go through `escapeRegex` because `.` and `(` mean something in a regex.
- Any one polluter lands before the victim in about half of all seeds.
  A group that holds it is missed with chance 0.5^8, about 0.4%.

## Try it

```bash
node src/cli.ts order fixtures/order.test.tsx
```

Verified output, 25 s:

```
order-dependent  order: reader assumes empty cache  (seed 3, fails 16/16)
  polluted by: order: writer populates cache
```

## Limits

- 8 seeds: a rare polluter can be missed (about 0.4% per probe).
- Two polluters that only fail together are returned as a list, marked "(needs several together)".
- Tests with the same name in one file cannot be told apart.
