import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { fileOfTestId, nameOfTestId, makeTestId, unwrap } from "./run.ts";
import type { TestResult } from "./run.ts";

const file = fc.stringMatching(/^[a-z:\/]{0,6}$/);
const anyName = fc.string({ unit: "binary" });

test("test ids: file and name are recovered from the id, whatever characters they hold", () => {
  fc.assert(
    fc.property(file, anyName, (f, n) => {
      const id = makeTestId(f, n);
      return fileOfTestId(id) === f && nameOfTestId(id) === n;
    }),
  );
});

const result: fc.Arbitrary<TestResult> = fc.record({
  id: fc.string(),
  status: fc.constantFrom("passed", "failed", "other"),
  ms: fc.nat(),
});

test("unwrap: a successful non-empty run returns its tests unchanged", () => {
  fc.assert(
    fc.property(fc.array(result, { minLength: 1 }), (tests) => {
      assert.deepEqual(unwrap({ kind: "ok", tests }), tests);
    }),
  );
});

test("unwrap: an empty run throws", () => {
  assert.throws(() => unwrap({ kind: "ok", tests: [] }));
});

test("unwrap: a crash throws and the message carries the exit code and stderr", () => {
  fc.assert(
    fc.property(fc.integer(), fc.string(), (exitCode, stderr) => {
      assert.throws(
        () => unwrap({ kind: "crash", exitCode, stderr }),
        (e: Error) => e.message.includes(String(exitCode)) && e.message.includes(stderr),
      );
    }),
  );
});
