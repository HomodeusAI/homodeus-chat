import { test } from "node:test";
import assert from "node:assert/strict";
import { extractMentionHandles, resolveMentions } from "../lib/mentions";

test("extracts and lowercases handles", () => {
  assert.deepEqual(extractMentionHandles("hey @CRM and @beacon"), ["crm", "beacon"]);
});

test("does not treat an email as a mention", () => {
  assert.deepEqual(extractMentionHandles("mail me at joao@homodeus.com"), []);
});

test("dedupes repeated mentions", () => {
  assert.deepEqual(extractMentionHandles("@crm @crm @crm"), ["crm"]);
});

test("handles mention at start of string and after punctuation", () => {
  assert.deepEqual(extractMentionHandles("@crm, also (@beacon)"), ["crm", "beacon"]);
});

test("resolve drops author self-mention and unresolved handles", () => {
  const map = new Map([
    ["crm", "p_crm"],
    ["beacon", "p_beacon"],
  ]);
  const r = resolveMentions(["crm", "beacon", "ghost"], map, "p_crm");
  assert.deepEqual(r.resolved, ["p_beacon"]);
  assert.deepEqual(r.unresolved, ["ghost"]);
});
