#!/usr/bin/env node
// End-to-end demo of dsh-jev: four realistic coding-agent judgments.
//
//   TYPESAFE_API_KEY=... node examples/demo.mjs
//
// Every call goes to api.typesafe.ai. The states below are synthetic and
// contain no real code, credentials, or user data.

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { check, route, score, evaluate, verdict } from "../lib/jev.mjs";

const execAsync = promisify(exec);
const results = [];
const model = [];

function record(scenario, tool, answer) {
  results.push({ scenario, tool, ...answer });
}

function pad(value, width) {
  const text = String(value);
  return text.length >= width ? text.slice(0, width) : text + " ".repeat(width - text.length);
}

function fmtProbability(value) {
  return typeof value === "number" ? value.toFixed(2) : "n/a";
}

console.log("dsh-jev demo: four judgments, no text generation\n");

// 1. Failure triage: run a command that really fails, then ask about it.
let exitCode = 0;
let output = "";
try {
  await execAsync("node -e \"require('@example/telemetry')\"", { timeout: 15000 });
} catch (error) {
  exitCode = typeof error.code === "number" ? error.code : 1;
  output = String(error.stderr || error.message || error);
}

const triage = await evaluate({
  state: "Command: node -e require('@example/telemetry')\nExit code: " + exitCode + "\nOutput:\n" + output.slice(0, 1500),
  questions: {
    transient: { type: "noul", instructions: "Is this failure transient, meaning a retry could succeed?" },
    missing_dependency: { type: "noul", instructions: "Is this a missing dependency or version conflict?" },
    needs_human: { type: "noul", instructions: "Does this need a human decision rather than an automated fix?" },
  },
});
model.push(triage.model);
for (const [name, answer] of Object.entries(triage.answers)) {
  record("failure triage", "jev_evaluate:" + name, {
    answer: verdict(answer.noul),
    probability: answer.noul,
  });
}

// 2. Routing: which subsystem owns this bug?
const routed = await route({
  state:
    "Bug report: checkout completes and the order is created, but the confirmation email never arrives. " +
    "The API log shows the order worker timed out calling the mail service, then retried twice.",
  question: "Which subsystem should own this bug?",
  options: {
    web_frontend: "Browser app and checkout UI",
    orders_api: "Order creation and checkout API",
    mail_service: "Transactional email delivery",
    infrastructure: "Network, queues, or hosting",
  },
});
model.push(routed.model);
const topProbability = Math.max(...Object.values(routed.probabilities || {}));
record("routing", "jev_route", { answer: routed.choice, probability: topProbability });

// 3. Scoring: how bad is this migration?
const scored = await score({
  state:
    "Deploy step 4 runs a migration that drops and recreates the users table. It has no backup step, " +
    "no dry run, and the rollback section says 'restore from snapshot'.",
  question: "How severe is this change?",
  levels: ["Cosmetic", "Minor", "Major", "Critical"],
});
model.push(scored.model);
record("severity", "jev_score", { answer: scored.legend[String(Math.round(scored.score))] ?? scored.score, probability: scored.confidence });

// 4. Review gate: two judgments, one call.
const diff = [
  "def find_user(request):",
  "    user_id = request.args.get('id')",
  "    query = 'SELECT * FROM users WHERE id = ' + user_id",
  "    return db.execute(query)",
].join("\n");

const review = await evaluate({
  state: "Proposed change:\n" + diff,
  questions: {
    security_risk: { type: "noul", instructions: "Does this change introduce a security risk?" },
    blocks_merge: { type: "noul", instructions: "Would a senior engineer block this change as-is?" },
  },
});
model.push(review.model);
for (const [name, answer] of Object.entries(review.answers)) {
  record("code review gate", "jev_evaluate:" + name, { answer: verdict(answer.noul), probability: answer.noul });
}

// Report
const width = Math.max(...results.map((row) => row.tool.length)) + 2;
console.log(pad("scenario", 20) + pad("tool", width) + pad("answer", 14) + "p");
console.log("-".repeat(20 + width + 14 + 6));
for (const row of results) {
  console.log(pad(row.scenario, 20) + pad(row.tool, width) + pad(row.answer, 14) + fmtProbability(row.probability));
}
console.log("\nmodel: " + [...new Set(model)].join(", "));
console.log("thresholds: act at 0.70, ask below 0.40, otherwise unsure");
