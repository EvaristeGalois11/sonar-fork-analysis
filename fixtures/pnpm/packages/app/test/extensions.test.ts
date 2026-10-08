import assert from "node:assert/strict";
import { test } from "node:test";
import common from "../src/common.cjs";
import { half } from "../src/module.mjs";
import { double } from "../src/plain.js";

test("double", () => {
  assert.equal(double(2), 4);
});

test("half", () => {
  assert.equal(half(4), 2);
});

test("triple", () => {
  assert.equal(common.triple(2), 6);
});
