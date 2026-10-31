#!/usr/bin/env node
// Level 1 example: run one command, then ask Jev how to treat the failure.
//
//   node examples/triage.mjs "npm test"
//   TYPESAFE_API_KEY=... node examples/triage.mjs "some failing command"
//
// Prints the command outcome, the model id, and the calibrated answers.

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { evaluate, verdict } from "../lib/jev.mjs";

const execAsync = promisify(exec);
const command = process.argv.slice(2).join(" ") || "node -e \"require('a-package-that-does-not-exist')\"";
const TIMEOUT_MS = 60000;

let exitCode = 0;
let output = "";
try {
  const result = await execAsync(command, { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
  output = String(result.stdout || "") + String(result.stderr || "");
} catch (error) {
  exitCode = typeof error.code === "number" ? error.code : 1;
  output = String(error.stdout || "") + String(error.stderr || "") || String(error.message || error);
}

const state = [
  "Command: " + command,
  "Exit code: " + exitCode,
  "Output tail:",
  output.slice(-4000) || "(no output)",
].join("\n");

const result = await evaluate({
  state,
  questions: {
    transient: { type: "noul", instructions: "Is this failure transient, meaning a retry could succeed?" },
    missing_dependency: { type: "noul", instructions: "Is this a missing dependency or a version conflict?" },
    needs_human: { type: "noul", instructions: "Does this failure need a human decision rather than an automated fix?" },
  },
});

const answers = result.answers;
const summarize = (answer) =>
  answer && typeof answer.noul === "number"
    ? { probability: answer.noul, verdict: verdict(answer.noul) }
    : answer;

console.log(
  JSON.stringify(
    {
      command,
      exitCode,
      model: result.model,
      usage: result.usage,
      answers: {
        transient: summarize(answers.transient),
        missing_dependency: summarize(answers.missing_dependency),
        needs_human: summarize(answers.needs_human),
      },
    },
    null,
    2
  )
);
