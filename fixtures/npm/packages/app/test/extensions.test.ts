import assert from "node:assert/strict";
import { test } from "node:test";
import common from "../src/common.cts";
import { half } from "../src/module.mts";

test("half", () => {
  assert.equal(half(4), 2);
});

test("triple", () => {
  assert.equal(common.triple(2), 6);
});
