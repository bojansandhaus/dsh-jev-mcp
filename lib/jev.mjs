// TypeSafe Jev client for DeepSeek Harness.
//
// Jev ("System One") evaluates typed questions against a state and returns
// calibrated probabilities instead of generated text. This module has no
// dependencies: it calls the HTTP API directly.
//
// API: POST https://api.typesafe.ai/v1/systemone
// Auth: Authorization: Bearer <TYPESAFE_API_KEY>

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_API_URL = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_MODEL = "jev-latest";
export const THRESHOLDS = Object.freeze({ act: 0.7, ask: 0.4 });
export const QUESTION_TYPES = Object.freeze(["noul", "choice", "score"]);
export const DEFAULT_KEY_FILE = join(homedir(), ".dsh", "secrets", "jev.env");

export class JevError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "JevError";
    this.code = options.code || "jev_error";
    this.status = options.status || 0;
    this.retryable = Boolean(options.retryable);
  }
}

function parseKeyFile(file) {
  if (!existsSync(file)) return "";
  const text = readFileSync(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match && match[1] === "TYPESAFE_API_KEY") {
      return match[2].replace(/^["']|["']$/g, "").trim();
    }
  }
  const raw = text.trim();
  return raw.startsWith("apikey_") ? raw : "";
}

/** Resolve the API key from an explicit value, the environment, or a key file. */
export function resolveApiKey(options = {}) {
  const explicit = options.apiKey || process.env.TYPESAFE_API_KEY;
  if (explicit && explicit.trim()) return explicit.trim();
  const file = options.keyFile || process.env.JEV_KEY_FILE || DEFAULT_KEY_FILE;
  const fromFile = parseKeyFile(file);
  if (fromFile) return fromFile;
  throw new JevError(
    "TYPESAFE_API_KEY is not set. Pass apiKey, set TYPESAFE_API_KEY, or write it to " + file + ".",
    { code: "missing_key" }
  );
}

/** Remove common credential and personal-data shapes from text before it leaves the machine. */
export function redact(text) {
  if (text === undefined || text === null) return text;
  let out = String(text);
  out = out.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[REDACTED_PRIVATE_KEY]"
  );
  out = out.replace(
    /\b(?:sk-[A-Za-z0-9_-]{10,}|apikey_[A-Za-z0-9_]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g,
    "[REDACTED_TOKEN]"
  );
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [REDACTED]");
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[REDACTED_EMAIL]");
  out = out.replace(/\b[0-9a-f]{40,}\b/gi, "[REDACTED_HEX]");
  return out;
}

function assertState(state) {
  if (typeof state !== "string" || !state.trim()) {
    throw new JevError("state must be a non-empty string", { code: "invalid_arguments" });
  }
}

function assertQuestion(name, spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new JevError("question '" + name + "' must be an object", { code: "invalid_arguments" });
  }
  if (!QUESTION_TYPES.includes(spec.type)) {
    throw new JevError("question '" + name + "' type must be one of " + QUESTION_TYPES.join(", "), {
      code: "invalid_arguments",
    });
  }
  if (typeof spec.instructions !== "string" || !spec.instructions.trim()) {
    throw new JevError("question '" + name + "' needs a non-empty instructions string", {
      code: "invalid_arguments",
    });
  }
  if (spec.type === "choice") {
    const criteria = spec.criteria;
    if (!criteria || typeof criteria !== "object" || Array.isArray(criteria) || !Object.keys(criteria).length) {
      throw new JevError("question '" + name + "' (choice) needs a non-empty criteria object", {
        code: "invalid_arguments",
      });
    }
    if (Object.keys(criteria).length < 2) {
      throw new JevError("question '" + name + "' (choice) needs at least two options", {
        code: "invalid_arguments",
      });
    }
  }
  if (spec.type === "score") {
    const criteria = spec.criteria || spec.levels;
    if (!Array.isArray(criteria) || !criteria.length) {
      throw new JevError("question '" + name + "' (score) needs criteria or levels as a non-empty array", {
        code: "invalid_arguments",
      });
    }
  }
}

function normalizeQuestions(questions) {
  if (!questions || typeof questions !== "object" || Array.isArray(questions) || !Object.keys(questions).length) {
    throw new JevError("questions must be a non-empty object mapping name to question spec", {
      code: "invalid_arguments",
    });
  }
  const normalized = {};
  for (const [name, spec] of Object.entries(questions)) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) {
      throw new JevError("invalid question name '" + name + "'", { code: "invalid_arguments" });
    }
    assertQuestion(name, spec);
    const question = { type: spec.type, instructions: spec.instructions };
    if (spec.type === "choice") question.criteria = spec.criteria;
    else if (spec.type === "score") question.criteria = spec.criteria || spec.levels;
    else if (spec.criterion && typeof spec.criterion === "object" && Object.keys(spec.criterion).length) {
      question.criterion = spec.criterion;
    }
    normalized[name] = question;
  }
  return normalized;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Evaluate one or more typed questions against a single state.
 * Returns { answers, model, usage }. Answers are keyed by question name.
 */
export async function evaluate(options) {
  const {
    state,
    questions,
    model = DEFAULT_MODEL,
    apiKey,
    keyFile,
    apiUrl = process.env.JEV_API_URL || DEFAULT_API_URL,
    timeoutMs = 45000,
    maxRetries = 2,
    redactState = false,
    fetchImpl = fetch,
  } = options || {};

  assertState(state);
  const normalized = normalizeQuestions(questions);
  const key = resolveApiKey({ apiKey, keyFile });
  const payload = {
    state: redactState ? redact(state) : state,
    model,
    questions: normalized,
  };

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(apiUrl, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (attempt < maxRetries) {
        await sleep(400 * (attempt + 1));
        continue;
      }
      throw new JevError("Jev API unreachable: " + (error && error.message ? error.message : String(error)), {
        code: "unreachable",
        retryable: true,
      });
    }

    if (response.status === 401) {
      throw new JevError("Jev rejected the API key (401). Check TYPESAFE_API_KEY.", {
        code: "auth",
        status: 401,
      });
    }
    if (response.status === 402) {
      throw new JevError("Jev account issue (402): credits or plan. Check console.typesafe.ai.", {
        code: "billing",
        status: 402,
      });
    }
    if (response.status === 422) {
      const detail = (await response.text()).slice(0, 500);
      throw new JevError("Jev rejected the request (422): " + detail, {
        code: "invalid_request",
        status: 422,
      });
    }
    if (response.status === 429 || response.status >= 500) {
      if (attempt < maxRetries) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      const detail = (await response.text()).slice(0, 300);
      throw new JevError("Jev API error " + response.status + ": " + detail, {
        code: "api_error",
        status: response.status,
        retryable: true,
      });
    }
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new JevError("Jev API error " + response.status + ": " + detail, {
        code: "api_error",
        status: response.status,
      });
    }

    const body = await response.json();
    if (!body || typeof body !== "object" || !body.answers) {
      throw new JevError("Jev returned a malformed response", { code: "bad_response" });
    }
    return { answers: body.answers, model: body.model || model, usage: body.usage || null };
  }

  throw new JevError("Jev request failed after retries", { code: "unreachable", retryable: true });
}

/** Map a probability to a coarse verdict using the configured thresholds. */
export function verdict(probability, thresholds = THRESHOLDS) {
  if (typeof probability !== "number" || Number.isNaN(probability)) {
    throw new JevError("verdict needs a numeric probability", { code: "invalid_arguments" });
  }
  if (probability >= thresholds.act) return "yes";
  if (probability < thresholds.ask) return "no";
  return "unsure";
}

function requireAnswer(result, name) {
  const answer = result.answers[name];
  if (!answer || typeof answer !== "object") {
    throw new JevError("Jev response is missing the answer for '" + name + "'", { code: "bad_response" });
  }
  return answer;
}

/** Ask one yes/no question. Returns { probability, verdict, model, usage }. */
export async function check(options) {
  const { state, question, criterion, model, ...rest } = options || {};
  if (typeof question !== "string" || !question.trim()) {
    throw new JevError("question must be a non-empty string", { code: "invalid_arguments" });
  }
  const spec = { type: "noul", instructions: question };
  if (criterion) spec.criterion = criterion;
  const result = await evaluate({ ...rest, state, questions: { answer: spec }, model });
  const answer = requireAnswer(result, "answer");
  const probability = typeof answer.noul === "number" ? answer.noul : null;
  return {
    type: "noul",
    probability,
    verdict: probability === null ? null : verdict(probability, rest.thresholds),
    model: result.model,
    usage: result.usage,
  };
}

/** Ask Jev to choose one option. options is a name -> description object. */
export async function route(options) {
  const { state, question, options: choices, model, ...rest } = options || {};
  if (typeof question !== "string" || !question.trim()) {
    throw new JevError("question must be a non-empty string", { code: "invalid_arguments" });
  }
  let criteria = choices;
  if (Array.isArray(choices)) {
    criteria = Object.fromEntries(choices.map((value, index) => [String(index), String(value)]));
  }
  if (!criteria || typeof criteria !== "object" || Object.keys(criteria).length < 2) {
    throw new JevError("options must be an object with at least two named choices", {
      code: "invalid_arguments",
    });
  }
  const result = await evaluate({
    ...rest,
    state,
    model,
    questions: { answer: { type: "choice", instructions: question, criteria } },
  });
  const answer = requireAnswer(result, "answer");
  return {
    type: "choice",
    choice: answer.choice,
    probabilities: answer.probabilities || null,
    confidence: typeof answer.confidence === "number" ? answer.confidence : null,
    model: result.model,
    usage: result.usage,
  };
}

/** Rate the state on an ordered rubric. levels are lowest to highest. */
export async function score(options) {
  const { state, question, levels, model, ...rest } = options || {};
  if (typeof question !== "string" || !question.trim()) {
    throw new JevError("question must be a non-empty string", { code: "invalid_arguments" });
  }
  if (!Array.isArray(levels) || !levels.length) {
    throw new JevError("levels must be a non-empty array, lowest first", { code: "invalid_arguments" });
  }
  const result = await evaluate({
    ...rest,
    state,
    model,
    questions: { answer: { type: "score", instructions: question, criteria: levels } },
  });
  const answer = requireAnswer(result, "answer");
  return {
    type: "score",
    score: typeof answer.score === "number" ? answer.score : null,
    legend: answer.legend || null,
    probabilities: answer.probabilities || null,
    confidence: typeof answer.confidence === "number" ? answer.confidence : null,
    model: result.model,
    usage: result.usage,
  };
}
