import assert from "node:assert/strict";
import { test } from "node:test";
import { fizzbuzz } from "../src/fizzbuzz.ts";

test("fizzbuzz", () => {
  assert.equal(fizzbuzz(15), "FizzBuzz");
  assert.equal(fizzbuzz(9), "Fizz");
  assert.equal(fizzbuzz(10), "Buzz");
  assert.equal(fizzbuzz(7), "7");
});
