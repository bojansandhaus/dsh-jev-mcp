import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  evaluate,
  check,
  route,
  score,
  verdict,
  redact,
  resolveApiKey,
  JevError,
  DEFAULT_API_URL,
} from "../lib/jev.mjs";

function okResponse(answers) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ answers, model: "jev-test", usage: { input_tokens: 1, output_tokens: 1 } }),
    text: async () => "",
  };
}

function errorResponse(status, body) {
  return { ok: false, status, json: async () => ({}), text: async () => body || "" };
}

test("redact removes credentials and emails", () => {
  const text = "key apikey_abc1234567890 mail someone@example.com bearer Bearer abcdefghijklmnop1234";
  const clean = redact(text);
  assert.ok(!clean.includes("apikey_abc1234567890"));
  assert.ok(!clean.includes("someone@example.com"));
  assert.ok(!clean.includes("abcdefghijklmnop1234"));
});

test("verdict uses thresholds", () => {
  assert.equal(verdict(0.9), "yes");
  assert.equal(verdict(0.7), "yes");
  assert.equal(verdict(0.5), "unsure");
  assert.equal(verdict(0.4), "unsure");
  assert.equal(verdict(0.1), "no");
  assert.throws(() => verdict("high"), JevError);
});

test("resolveApiKey reads a key file", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-"));
  const file = join(dir, "jev.env");
  writeFileSync(file, "# comment\nexport TYPESAFE_API_KEY=apikey_from_file\n");
  assert.equal(resolveApiKey({ keyFile: file }), "apikey_from_file");
  assert.throws(() => resolveApiKey({ keyFile: join(dir, "missing.env") }), /TYPESAFE_API_KEY/);
});

test("evaluate normalizes questions and returns answers", async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return okResponse({ a: { type: "noul", noul: 0.8 } });
  };
  const result = await evaluate({
    state: "build failed",
    questions: {
      a: { type: "noul", instructions: "Is it transient?" },
      b: { type: "score", instructions: "Severity?", levels: ["low", "high"] },
    },
    apiKey: "test-key",
    fetchImpl,
  });
  assert.equal(result.answers.a.noul, 0.8);
  assert.equal(result.model, "jev-test");
  assert.equal(captured.url, DEFAULT_API_URL);
  assert.equal(captured.init.headers.Authorization, "Bearer test-key");
  const body = JSON.parse(captured.init.body);
  assert.equal(body.state, "build failed");
  assert.deepEqual(body.questions.b.criteria, ["low", "high"]);
});

test("redactState redacts the outbound state", async () => {
  let body;
  const fetchImpl = async (url, init) => {
    body = JSON.parse(init.body);
    return okResponse({ a: { type: "noul", noul: 0.5 } });
  };
  await evaluate({
    state: "contact me@example.com",
    questions: { a: { type: "noul", instructions: "ok?" } },
    apiKey: "k",
    redactState: true,
    fetchImpl,
  });
  assert.ok(!body.state.includes("me@example.com"));
});

test("401 is not retried", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return errorResponse(401);
  };
  await assert.rejects(
    () => evaluate({ state: "s", questions: { a: { type: "noul", instructions: "q" } }, apiKey: "bad", fetchImpl }),
    (error) => error instanceof JevError && error.code === "auth"
  );
  assert.equal(calls, 1);
});

test("503 retries and then succeeds", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls < 3) return errorResponse(503, "upstream");
    return okResponse({ a: { type: "noul", noul: 0.2 } });
  };
  const result = await evaluate({
    state: "s",
    questions: { a: { type: "noul", instructions: "q" } },
    apiKey: "k",
    fetchImpl,
  });
  assert.equal(calls, 3);
  assert.equal(result.answers.a.noul, 0.2);
});

test("422 maps to invalid_request", async () => {
  const fetchImpl = async () => errorResponse(422, "bad criteria");
  await assert.rejects(
    () => evaluate({ state: "s", questions: { a: { type: "noul", instructions: "q" } }, apiKey: "k", fetchImpl }),
    (error) => error.code === "invalid_request" && /bad criteria/.test(error.message)
  );
});

test("check returns probability and verdict", async () => {
  const fetchImpl = async () => okResponse({ answer: { type: "noul", noul: 0.91 } });
  const result = await check({ state: "s", question: "transient?", apiKey: "k", fetchImpl });
  assert.equal(result.probability, 0.91);
  assert.equal(result.verdict, "yes");
});

test("route accepts an options array", async () => {
  let body;
  const fetchImpl = async (url, init) => {
    body = JSON.parse(init.body);
    return okResponse({ answer: { type: "choice", choice: "1", probabilities: { "0": 0.1, "1": 0.9 }, confidence: 0.9 } });
  };
  const result = await route({ state: "s", question: "who?", options: ["web", "db"], apiKey: "k", fetchImpl });
  assert.equal(result.choice, "1");
  assert.deepEqual(body.questions.answer.criteria, { "0": "web", "1": "db" });
});

test("score sends levels as criteria", async () => {
  let body;
  const fetchImpl = async (url, init) => {
    body = JSON.parse(init.body);
    return okResponse({ answer: { type: "score", score: 1.5, legend: { 0: "low", 1: "high" }, confidence: 0.8 } });
  };
  const result = await score({ state: "s", question: "severity?", levels: ["low", "high"], apiKey: "k", fetchImpl });
  assert.equal(result.score, 1.5);
  assert.deepEqual(body.questions.answer.criteria, ["low", "high"]);
});

test("invalid arguments are rejected locally", async () => {
  await assert.rejects(() => evaluate({ state: "", questions: { a: { type: "noul", instructions: "q" } }, apiKey: "k" }), /state/);
  await assert.rejects(() => evaluate({ state: "s", questions: {}, apiKey: "k" }), /questions/);
  await assert.rejects(
    () => evaluate({ state: "s", questions: { a: { type: "choice", instructions: "q", criteria: { one: "x" } } }, apiKey: "k" }),
    /at least two options/
  );
});
