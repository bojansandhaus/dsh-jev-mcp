# dsh-jev-mcp

TypeSafe Jev decision tools for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH).

[Jev](https://docs.typesafe.ai/introduction) is a "System One" decision model: it evaluates typed
questions against a state and returns structured answers with calibrated probabilities, instead of
generating text. It is useful inside a coding agent for the small judgments that show up constantly:
is this failure transient, which subsystem owns this bug, how severe is this defect, should this diff
be blocked.

This repository contains:

- `lib/jev.mjs`: a dependency-free client with `jevCheck`, `jevRoute`, `jevScore`,
  `jevEvaluate`, credential redaction, and probability thresholds.
- `server/jev-mcp.mjs`: a dependency-free stdio MCP server that exposes the same four operations
  as MCP tools, so native DSH modes and code mode can both call Jev.

No vendor SDK and no runtime dependencies: plain Node 20+.

## Tools

| MCP tool | Question type | Use it for |
|---|---|---|
| `jev_check` | noul (yes/no) | atomic binary judgments: "is this failure transient?", "does this diff touch auth?" |
| `jev_route` | choice | picking one option: which subsystem owns a bug, which fix strategy to try |
| `jev_score` | score | ordered rubric ratings: severity, risk, complexity |
| `jev_evaluate` | any mix | several judgments against one state in a single call |

All four return JSON, including the model id and token usage. Probabilities come from the service and
are not post-processed, except for the coarse `verdict` field that `jev_check` adds using the
thresholds below.

## Install

Requirements: Node.js 20 or newer, a DSH install, and a TypeSafe API key from
<https://console.typesafe.ai/keys>.

```sh
git clone <this-repo> dsh-jev-mcp
cd dsh-jev-mcp
bash scripts/install.sh
```

The installer copies the server to `${DSH_HOME:-$HOME/.dsh}/mcp/jev` and creates
`${DSH_HOME:-$HOME/.dsh}/secrets/jev.env` (mode 600) if it does not exist. Put the key in that file:

```sh
printf 'TYPESAFE_API_KEY=%s\n' 'apikey_your_key_here' > ~/.dsh/secrets/jev.env
chmod 600 ~/.dsh/secrets/jev.env
```

Then register the MCP server in your profile patch,
`${DSH_HOME:-$HOME/.dsh}/profiles/<profile>/cordis.patch.yml`, using
`config/cordis.patch.example.yml` as the template. Restart DSH afterwards: profile layers are
composed at process start, so the tools appear in the next session.

On the DSH desktop app, run the server with DSH's bundled Node by pointing `command` at the app
binary and setting `ELECTRON_RUN_AS_NODE: "1"` (see the example). On CLI installs plain `node`
is enough.

## Use from code mode

Code mode programs can import the library directly and call Jev inline, without a tool round trip:

```js
import { evaluate, check, verdict } from "file:///path/to/dsh-jev-mcp/lib/jev.mjs";

// One judgment
const { probability, verdict: answer } = await check({
  state: buildLogTail,
  question: "Is this failure transient, meaning a retry could succeed?",
});
if (answer === "yes") {
  // retry
}

// Several judgments against the same state, in one API call
const result = await evaluate({
  state: diff,
  questions: {
    blocks_merge: { type: "noul", instructions: "Would a senior engineer block this diff as-is?" },
    security_risk: { type: "noul", instructions: "Does this diff introduce a security risk?" },
    severity: { type: "score", instructions: "How severe is this change?", levels: ["Cosmetic", "Minor", "Major", "Blocks release"] },
  },
});
```

The API key is resolved in this order: the `apiKey` option, `TYPESAFE_API_KEY` in the environment,
then `${DSH_HOME:-$HOME/.dsh}/secrets/jev.env` (override the path with `JEV_KEY_FILE`). A code mode
sandbox often starts with an empty environment, so either pass `apiKey` explicitly or read the key
file from the program.

`examples/demo.mjs` runs four end-to-end judgments (failure triage, routing, severity scoring, and a
code review gate) and prints a summary table:

```sh
node examples/demo.mjs
```

`examples/triage.mjs` runs one command, captures its output, and asks three questions about the
failure:

```sh
node examples/triage.mjs "npm test"
```

## Library API

```js
const result = await evaluate({ state, questions, model, apiKey, keyFile, apiUrl, timeoutMs, maxRetries, redactState });
const checkResult = await check({ state, question, criterion, model, ...rest });
const routeResult = await route({ state, question, options, model, ...rest });   // options: { name: description }
const scoreResult = await score({ state, question, levels, model, ...rest });     // levels: lowest first
```

Shapes:

- `check`: `{ type: "noul", probability, verdict, model, usage }`
- `route`: `{ type: "choice", choice, probabilities, confidence, model, usage }`
- `score`: `{ type: "score", score, legend, probabilities, confidence, model, usage }`
- `evaluate`: `{ answers, model, usage }`

Errors throw `JevError` with a `code`: `missing_key`, `invalid_arguments`, `auth` (401),
`billing` (402), `invalid_request` (422), `api_error`, `unreachable`, `bad_response`.

Retries happen only for 429 and 5xx responses, twice by default.

## Thresholds

`jev_check` maps the probability to a coarse verdict with `THRESHOLDS = { act: 0.7, ask: 0.4 }`:

- `probability >= 0.7` becomes `"yes"`
- `probability < 0.4` becomes `"no"`
- otherwise `"unsure"`

Treat these as sane defaults, not calibrated policy. Tune them against your own outcomes. For
`jev_route`, compare the per-option `probabilities`; the separate `confidence` field is not the
same quantity.

## Security and privacy

- **Every call sends the state to TypeSafe** at `api.typesafe.ai`, together with your API key. Send
  only what the judgment needs: the failing log tail, the changed hunk, a compact situation
  summary. Do not send whole repositories or credential files.
- `redactState: true` (library) runs a conservative redactor over `state` first: private key
  blocks, common token shapes, bearer tokens, email addresses, long hex strings. It is a safety net,
  not a guarantee. Review what you send.
- The API key is read from a mode-600 file or the environment. It is never written to logs. The MCP
  server writes nothing to stdout except JSON-RPC; diagnostics, if any, would go to stderr.
- No analytics, no telemetry, no third-party dependencies.

## Design notes

- The MCP server speaks newline-delimited JSON-RPC over stdio (the MCP stdio framing) and implements
  `initialize`, `ping`, `tools/list`, and `tools/call`. It has no dependencies because DSH's stdio
  transport only needs that much.
- The protocol version is negotiated: the server echoes the client's requested version when it is
  one of the supported versions, otherwise it offers the newest it knows.
- Questions are validated locally (types, instructions, choice options, score levels), so malformed
  requests fail before any network call.
- The client uses `AbortSignal.timeout`, so a hung request cannot pin a session.

## Tests

```sh
npm test
```

The suite mocks the HTTP API and spawns the MCP server as a child process; it never contacts the
network and needs no key.

## Layout

```
lib/jev.mjs                 client, redaction, thresholds
server/jev-mcp.mjs          stdio MCP server
examples/triage.mjs         run a command, ask Jev about the failure
config/cordis.patch.example.yml   DSH profile snippet
scripts/install.sh          copy server into a DSH home
test/                       node:test suite
```

## License

MIT. See `LICENSE`.
