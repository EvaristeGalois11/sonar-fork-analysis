import assert from "node:assert/strict";
import { test } from "node:test";
import { banner } from "../src/main.ts";

test("banner", async () => {
  assert.match(await banner("package.json"), /^(Fizz|Buzz|FizzBuzz|\d+): /);
});
