#!/usr/bin/env node
// Minimal dependency-free MCP server for TypeSafe Jev.
//
// Transport: stdio, one JSON-RPC 2.0 message per line (the MCP stdio framing).
// Tools: jev_check, jev_route, jev_score, jev_evaluate.
//
// Configuration (environment):
//   TYPESAFE_API_KEY  API key. If unset, JEV_KEY_FILE is read.
//   JEV_KEY_FILE      Path to a KEY=VALUE file with TYPESAFE_API_KEY.
//                     Default: ~/.dsh/secrets/jev.env
//   JEV_API_URL       Override the API URL (tests only).

import { createInterface } from "node:readline";
import { check, route, score, evaluate, JevError } from "../lib/jev.mjs";

const SERVER_NAME = "dsh-jev";
const SERVER_VERSION = "0.1.0";
const PROTOCOLS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"];

const TOOLS = [
  {
    name: "jev_evaluate",
    description:
      "Ask TypeSafe Jev (a calibrated decision model, not a text model) several typed questions about one state in a single call. " +
      "Question types: noul (yes/no, returns a probability), choice (returns one option plus per-option probabilities), " +
      "score (returns a number on an ordered rubric). Keep each question atomic; decompose complex judgments into several questions. " +
      "The state is sent to api.typesafe.ai.",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", description: "Context to judge: error output, a diff, logs, or a compact situation summary." },
        questions: {
          type: "object",
          description:
            "Map of question name to {type, instructions, criteria?}. criteria is required for choice (object of option -> description) " +
            "and for score (array of levels, lowest first).",
          additionalProperties: { type: "object" },
        },
        model: { type: "string", description: "Optional Jev model id. Default: jev-latest." },
      },
      required: ["state", "questions"],
      additionalProperties: false,
    },
  },
  {
    name: "jev_check",
    description:
      "Ask one atomic yes/no question about a state and get the probability that the answer is yes. " +
      "Use for binary judgments: is this failure transient, does this diff touch auth, is this migration backward-compatible. " +
      "The state is sent to api.typesafe.ai.",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", description: "Context to judge." },
        question: { type: "string", description: "One atomic yes/no question." },
        criterion: { type: "object", description: "Optional structured requirements to check.", additionalProperties: true },
        model: { type: "string", description: "Optional Jev model id. Default: jev-latest." },
      },
      required: ["state", "question"],
      additionalProperties: false,
    },
  },
  {
    name: "jev_route",
    description:
      "Ask Jev to choose exactly one option for a state, with per-option probabilities. " +
      "Use for routing: which subsystem owns a bug, which fix strategy to try, which agent should handle a task. " +
      "The state is sent to api.typesafe.ai.",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", description: "Context to judge." },
        question: { type: "string", description: "The routing question." },
        options: {
          type: "object",
          description: "Map of option name to description. At least two options.",
          additionalProperties: { type: "string" },
        },
        model: { type: "string", description: "Optional Jev model id. Default: jev-latest." },
      },
      required: ["state", "question", "options"],
      additionalProperties: false,
    },
  },
  {
    name: "jev_score",
    description:
      "Rate a state on an ordered rubric (lowest first) and get a numeric score plus the level legend and probabilities. " +
      "Use for severity, risk, complexity, or confidence ratings. The state is sent to api.typesafe.ai.",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", description: "Context to judge." },
        question: { type: "string", description: "The scoring question." },
        levels: { type: "array", items: { type: "string" }, description: "Ordered levels, lowest first." },
        model: { type: "string", description: "Optional Jev model id. Default: jev-latest." },
      },
      required: ["state", "question", "levels"],
      additionalProperties: false,
    },
  },
];

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function commonOptions() {
  return {
    apiKey: process.env.TYPESAFE_API_KEY,
    keyFile: process.env.JEV_KEY_FILE,
    apiUrl: process.env.JEV_API_URL || undefined,
  };
}

async function callTool(name, args) {
  if (name === "jev_evaluate") {
    return evaluate({ ...commonOptions(), state: args.state, questions: args.questions, model: args.model });
  }
  if (name === "jev_check") {
    return check({ ...commonOptions(), state: args.state, question: args.question, criterion: args.criterion, model: args.model });
  }
  if (name === "jev_route") {
    return route({ ...commonOptions(), state: args.state, question: args.question, options: args.options, model: args.model });
  }
  if (name === "jev_score") {
    return score({ ...commonOptions(), state: args.state, question: args.question, levels: args.levels, model: args.model });
  }
  throw new JevError("unknown tool: " + name, { code: "unknown_tool" });
}

async function handle(message) {
  const id = message.id;
  const method = message.method;
  const params = message.params || {};

  if (method === "initialize") {
    const requested = params.protocolVersion;
    const protocolVersion = PROTOCOLS.includes(requested) ? requested : PROTOCOLS[0];
    return reply(id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") return;
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") return reply(id, { tools: TOOLS });
  if (method === "tools/call") {
    const name = params.name;
    const args = params.arguments || {};
    try {
      const result = await callTool(name, args);
      return reply(id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: false,
      });
    } catch (error) {
      const text = error instanceof JevError ? error.name + ": " + error.message : String((error && error.stack) || error);
      return reply(id, { content: [{ type: "text", text }], isError: true });
    }
  }
  if (id !== undefined) replyError(id, -32601, "method not found: " + method);
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let queue = Promise.resolve();

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  queue = queue.then(async () => {
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    try {
      await handle(message);
    } catch (error) {
      if (message.id !== undefined) replyError(message.id, -32603, String((error && error.message) || error));
    }
  });
});

rl.on("close", () => {
  queue.then(() => process.exit(0));
});
