import { test } from "node:test";
import assert from "node:assert/strict";
import { minuteBucket, splitByCooldown, BUCKET_MS } from "../lib/cooldown";

test("minuteBucket floors to the one-minute window and rolls at the boundary", () => {
  assert.equal(minuteBucket(0), 0);
  assert.equal(minuteBucket(BUCKET_MS - 1), 0);
  assert.equal(minuteBucket(BUCKET_MS), 1);
});

test("delivers up to the limit, then cools the rest of the pair's bucket", () => {
  // post-increment counts: the Kth A->b wake is the last delivered, the (K+1)th is dropped
  assert.deepEqual(splitByCooldown(["b"], new Map([["b", 6]]), 6), { deliver: ["b"], cooled: [] });
  assert.deepEqual(splitByCooldown(["b"], new Map([["b", 7]]), 6), { deliver: [], cooled: ["b"] });
});

test("each ordered pair is independent: one peer cools, the other still wakes", () => {
  const counts = new Map([
    ["b", 7], // over the limit
    ["c", 2], // under
  ]);
  assert.deepEqual(splitByCooldown(["b", "c"], counts, 6), { deliver: ["c"], cooled: ["b"] });
});

test("a missing count never drops a wake (fail open)", () => {
  assert.deepEqual(splitByCooldown(["b"], new Map(), 6), { deliver: ["b"], cooled: [] });
});

test("limit 0 mutes every agent->agent wake", () => {
  assert.deepEqual(splitByCooldown(["b"], new Map([["b", 1]]), 0), { deliver: [], cooled: ["b"] });
});
