import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

function startMockApi() {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        const first = Object.keys(parsed.questions || {})[0];
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            model: "jev-mock",
            answers: { [first]: { type: "noul", noul: 0.9 } },
            usage: { input_tokens: 3, output_tokens: 1 },
          })
        );
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function startServer(apiUrl) {
  const child = spawn(process.execPath, [join(repoRoot, "server", "jev-mcp.mjs")], {
    cwd: repoRoot,
    env: { ...process.env, TYPESAFE_API_KEY: "test-key", JEV_API_URL: apiUrl, JEV_KEY_FILE: "/nonexistent" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      waiter(message);
    }
  });
  let nextId = 1;
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  return { child, request };
}

test("MCP server handshake, tool list and tool call", async (t) => {
  const api = await startMockApi();
  const port = api.address().port;
  const { child, request } = startServer("http://127.0.0.1:" + port + "/v1/systemone");
  t.after(() => {
    child.kill();
    api.close();
  });

  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  });
  assert.equal(init.result.serverInfo.name, "dsh-jev");
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.ok(init.result.capabilities.tools);

  const list = await request("tools/list", {});
  const names = list.result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ["jev_check", "jev_evaluate", "jev_route", "jev_score"]);

  const call = await request("tools/call", {
    name: "jev_check",
    arguments: { state: "the build failed", question: "is it transient?" },
  });
  assert.equal(call.result.isError, false);
  const payload = JSON.parse(call.result.content[0].text);
  assert.equal(payload.probability, 0.9);
  assert.equal(payload.verdict, "yes");

  const bad = await request("tools/call", { name: "jev_check", arguments: { state: "" } });
  assert.equal(bad.result.isError, true);

  const unknown = await request("tools/call", { name: "jev_nope", arguments: {} });
  assert.equal(unknown.result.isError, true);
  assert.match(unknown.result.content[0].text, /unknown tool/);
});

test("MCP server answers ping and rejects unknown methods", async (t) => {
  const api = await startMockApi();
  const { child, request } = startServer("http://127.0.0.1:" + api.address().port + "/v1/systemone");
  t.after(() => {
    child.kill();
    api.close();
  });
  const pong = await request("ping", {});
  assert.deepEqual(pong.result, {});
  const unknown = await request("resources/list", {});
  assert.equal(unknown.error.code, -32601);
});
