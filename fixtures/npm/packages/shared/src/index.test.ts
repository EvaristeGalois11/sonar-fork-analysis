import assert from "node:assert/strict";
import { test } from "node:test";
import { fizzbuzz, readText, size } from "./index.ts";

test("fizzbuzz", () => {
  assert.equal(fizzbuzz(15), "FizzBuzz");
  assert.equal(fizzbuzz(9), "Fizz");
  assert.equal(fizzbuzz(10), "Buzz");
  assert.equal(fizzbuzz(7), "7");
});

test("files", async () => {
  assert.equal((await size("package.json")) > 0, true);
  assert.equal(readText("package.json").length > 0, true);
});
