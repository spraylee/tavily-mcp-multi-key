import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = path.join(projectRoot, "build/index.js");

async function startFakeTavily(behavior) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }

    const rawBody = Buffer.concat(chunks).toString("utf8");
    const body = rawBody ? JSON.parse(rawBody) : undefined;
    const apiKey = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    const requestRecord = {
      method: request.method,
      path: request.url,
      apiKey,
      accessMode: request.headers["x-tavily-access-mode"],
      body,
    };
    requests.push(requestRecord);

    try {
      await behavior(requestRecord, response);
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ detail: { error: error.message } }));
    }
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();

  return {
    requests,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function withMcpClient(baseUrl, apiKeys, callback, { singleKey = false } = {}) {
  const childEnv = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== undefined),
  );
  delete childEnv.TAVILY_API_KEY;
  if (singleKey) {
    childEnv.TAVILY_API_KEY = apiKeys[0];
    childEnv.TAVILY_API_KEYS = "";
  } else {
    childEnv.TAVILY_API_KEYS = apiKeys.join(",");
  }
  childEnv.TAVILY_API_BASE_URL = baseUrl;

  const client = new Client(
    { name: "tavily-mcp-multi-key-test", version: "0.1.0" },
    { capabilities: {} },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: childEnv,
  });

  try {
    await client.connect(transport);
    return await callback(client);
  } finally {
    await client.close();
  }
}

function usageBehavior(usageByKey) {
  return async (requestRecord, response) => {
    if (requestRecord.path === "/usage") {
      const usage = usageByKey[requestRecord.apiKey] ?? { usage: 0, limit: 1000 };
      sendJson(response, 200, {
        key: { usage: usage.usage, limit: usage.limit },
        account: {
          plan_usage: usage.accountUsage ?? usage.usage,
          plan_limit: usage.accountLimit ?? usage.limit,
        },
      });
      return;
    }

    sendJson(response, 200, {
      query: requestRecord.body?.query,
      results: [{
        title: "Fake result",
        url: "https://example.com/result",
        content: "Fake content",
        score: 1,
      }],
    });
  };
}

test("启动预检会跳过已耗尽 Key", async () => {
  const fakeTavily = await startFakeTavily(usageBehavior({
    "key-a": { usage: 1000, limit: null, accountUsage: 1000, accountLimit: 1000 },
    "key-b": { usage: 1000, limit: null, accountUsage: 1000, accountLimit: 1000 },
    "key-c": { usage: 0, limit: null, accountUsage: 0, accountLimit: 1000 },
  }));

  try {
    await withMcpClient(fakeTavily.baseUrl, ["key-a", "key-b", "key-c"], async (client) => {
      const tools = await client.listTools();
      assert.deepEqual(
        tools.tools.map((tool) => tool.name),
        ["tavily_search", "tavily_extract", "tavily_crawl", "tavily_map", "tavily_research", "tavily_key_status"],
      );

      const result = await client.callTool({
        name: "tavily_search",
        arguments: { query: "test" },
      });
      assert.equal(result.isError, undefined);
      assert.deepEqual(
        fakeTavily.requests.filter((request) => request.path === "/search").map((request) => request.apiKey),
        ["key-c"],
      );
      assert.equal(fakeTavily.requests.find((request) => request.path === "/search").body.api_key, "key-c");
    });
  } finally {
    await fakeTavily.close();
  }
});

test("兼容旧的单 Key 配置", async () => {
  const fakeTavily = await startFakeTavily(usageBehavior({
    "key-a": { usage: 0, limit: 1000 },
  }));

  try {
    await withMcpClient(fakeTavily.baseUrl, ["key-a"], async (client) => {
      const result = await client.callTool({
        name: "tavily_search",
        arguments: { query: "single key" },
      });

      assert.equal(result.isError, undefined);
      const searchRequest = fakeTavily.requests.find((request) => request.path === "/search");
      assert.equal(searchRequest.apiKey, "key-a");
      assert.equal(searchRequest.body.api_key, "key-a");
    }, { singleKey: true });
  } finally {
    await fakeTavily.close();
  }
});

test("只在启动时查询一次额度，后续请求不刷新共享余额", async () => {
  const fakeTavily = await startFakeTavily(usageBehavior({
    "key-a": { usage: 100, limit: 1000 },
    "key-b": { usage: 900, limit: 1000 },
  }));

  try {
    await withMcpClient(fakeTavily.baseUrl, ["key-a", "key-b"], async (client) => {
      await client.callTool({
        name: "tavily_search",
        arguments: { query: "first" },
      });
      await client.callTool({
        name: "tavily_search",
        arguments: { query: "second" },
      });

      assert.equal(
        fakeTavily.requests.filter((request) => request.path === "/usage").length,
        2,
      );
      assert.deepEqual(
        fakeTavily.requests.filter((request) => request.path === "/search").map((request) => request.apiKey),
        ["key-a", "key-a"],
      );
    });
  } finally {
    await fakeTavily.close();
  }
});

test("没有 Key 时保留 keyless 请求模式", async () => {
  const fakeTavily = await startFakeTavily(async (requestRecord, response) => {
    sendJson(response, 200, {
      query: requestRecord.body?.query,
      results: [{ title: "Keyless result", url: "https://example.com", content: "ok", score: 1 }],
    });
  });

  try {
    await withMcpClient(fakeTavily.baseUrl, [], async (client) => {
      const result = await client.callTool({
        name: "tavily_search",
        arguments: { query: "keyless" },
      });

      assert.equal(result.isError, undefined);
      const searchRequest = fakeTavily.requests.find((request) => request.path === "/search");
      assert.equal(searchRequest.apiKey, undefined);
      assert.equal(searchRequest.accessMode, "keyless");
      assert.equal(searchRequest.body.api_key, undefined);
    });
  } finally {
    await fakeTavily.close();
  }
});

test("432 失败后切换 Key，后续请求不再尝试耗尽 Key", async () => {
  const fakeTavily = await startFakeTavily(async (requestRecord, response) => {
    if (requestRecord.path === "/usage") {
      sendJson(response, 200, { key: { usage: 0, limit: 1000 } });
      return;
    }

    if (requestRecord.path === "/search" && ["key-a", "key-b"].includes(requestRecord.apiKey)) {
      sendJson(response, 432, { detail: { error: "quota exhausted" } });
      return;
    }

    sendJson(response, 200, {
      query: requestRecord.body?.query,
      results: [{ title: "Healthy result", url: "https://example.com", content: "ok", score: 1 }],
    });
  });

  try {
    await withMcpClient(fakeTavily.baseUrl, ["key-a", "key-b", "key-c"], async (client) => {
      const firstResult = await client.callTool({
        name: "tavily_search",
        arguments: { query: "first" },
      });
      const secondResult = await client.callTool({
        name: "tavily_search",
        arguments: { query: "second" },
      });

      assert.equal(firstResult.isError, undefined);
      assert.equal(secondResult.isError, undefined);
      assert.deepEqual(
        fakeTavily.requests.filter((request) => request.path === "/search").map((request) => request.apiKey),
        ["key-a", "key-b", "key-c", "key-c"],
      );
    });
  } finally {
    await fakeTavily.close();
  }
});

test("research 流式 fallback 在整个任务中绑定同一个 Key", async () => {
  const fakeTavily = await startFakeTavily(async (requestRecord, response) => {
    if (requestRecord.path === "/usage") {
      sendJson(response, 200, { key: { usage: 0, limit: 1000 } });
      return;
    }

    if (requestRecord.path === "/research" && !requestRecord.body?.stream) {
      sendJson(response, 400, { detail: { error_code: "research_stream_required" } });
      return;
    }

    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end('data: {"choices":[{"delta":{"content":"fake report"}}]}\n\nevent: done\n\n');
  });

  try {
    await withMcpClient(fakeTavily.baseUrl, ["key-a", "key-b"], async (client) => {
      const result = await client.callTool({
        name: "tavily_research",
        arguments: { input: "test", model: "mini" },
      });

      assert.equal(result.isError, undefined);
      assert.match(result.content[0].text, /fake report/);
      assert.deepEqual(
        fakeTavily.requests.filter((request) => request.path === "/research").map((request) => request.apiKey),
        ["key-a", "key-a"],
      );
    });
  } finally {
    await fakeTavily.close();
  }
});

test("research 轮询失败不会在其他 Key 上重复创建任务", async () => {
  const fakeTavily = await startFakeTavily(async (requestRecord, response) => {
    if (requestRecord.path === "/usage") {
      sendJson(response, 200, { key: { usage: 0, limit: 1000 } });
      return;
    }

    if (requestRecord.path === "/research" && !requestRecord.body?.stream) {
      sendJson(response, 200, { request_id: "research-1" });
      return;
    }

    if (requestRecord.path === "/research/research-1") {
      sendJson(response, 432, { detail: { error: "quota exhausted" } });
      return;
    }

    sendJson(response, 500, { detail: { error: "unexpected request" } });
  });

  try {
    await withMcpClient(fakeTavily.baseUrl, ["key-a", "key-b"], async (client) => {
      const result = await client.callTool({
        name: "tavily_research",
        arguments: { input: "test", model: "mini" },
      });

      assert.equal(result.isError, true);
      assert.deepEqual(
        fakeTavily.requests
          .filter((request) => request.path === "/research" || request.path === "/research/research-1")
          .map((request) => request.apiKey),
        ["key-a", "key-a"],
      );
    });
  } finally {
    await fakeTavily.close();
  }
});

test("tavily_key_status 报告脱敏 Key 与探测时间，refresh=true 会重新探测", async () => {
  const fakeTavily = await startFakeTavily(usageBehavior({
    "tvly-test-key-aaaa": { usage: 100, limit: 1000 },
    "tvly-test-key-bbbb": { usage: 500, limit: 1000 },
  }));

  try {
    await withMcpClient(fakeTavily.baseUrl, ["tvly-test-key-aaaa", "tvly-test-key-bbbb"], async (client) => {
      const result = await client.callTool({
        name: "tavily_key_status",
        arguments: { refresh: true },
      });

      assert.equal(result.isError, undefined);
      const text = result.content[0].text;
      // Keys are masked (prefix 8 + last 4), raw keys must not leak.
      assert.doesNotMatch(text, /tvly-test-key-aaaa/);
      assert.doesNotMatch(text, /tvly-test-key-bbbb/);
      assert.match(text, /#1 tvly-tes\.\.\.aaaa — active, remaining=900/);
      assert.match(text, /#2 tvly-tes\.\.\.bbbb — active, remaining=500/);
      assert.match(text, /Last probed: \d+s ago/);
      assert.match(text, /Daily re-probe: 05:00 Asia\/Shanghai/);
      // refresh=true triggers a second probe round on top of startup preflight
      assert.equal(
        fakeTavily.requests.filter((request) => request.path === "/usage").length,
        4,
      );
    });
  } finally {
    await fakeTavily.close();
  }
});

test("月度额度重置后，exhausted Key 通过探测复活并回到队首", async () => {
  let keyAUsage = 1000;
  const fakeTavily = await startFakeTavily(async (requestRecord, response) => {
    if (requestRecord.path === "/usage") {
      sendJson(response, 200, {
        key: { usage: requestRecord.apiKey === "tvly-test-key-aaaa" ? keyAUsage : 100, limit: 1000 },
        account: { plan_usage: 0, plan_limit: 1000 },
      });
      return;
    }

    if (requestRecord.path === "/search" && requestRecord.apiKey === "tvly-test-key-aaaa" && keyAUsage === 1000) {
      sendJson(response, 432, { detail: { error: "quota exhausted" } });
      return;
    }

    sendJson(response, 200, {
      query: requestRecord.body?.query,
      results: [{ title: "Revived", url: "https://example.com", content: "ok", score: 1 }],
    });
  });

  try {
    await withMcpClient(fakeTavily.baseUrl, ["tvly-test-key-aaaa", "tvly-test-key-bbbb"], async (client) => {
      // Startup probe: aaaa exhausted (0 left), bbbb has 900 → search uses bbbb.
      const first = await client.callTool({ name: "tavily_search", arguments: { query: "first" } });
      assert.equal(first.isError, undefined);
      assert.deepEqual(
        fakeTavily.requests.filter((r) => r.path === "/search").map((r) => r.apiKey),
        ["tvly-test-key-bbbb"],
      );

      // Month resets: quota is back on aaaa.
      keyAUsage = 0;

      // Status refresh revives aaaa; with 1000 left it sorts back to #1.
      const status = await client.callTool({ name: "tavily_key_status", arguments: { refresh: true } });
      assert.match(status.content[0].text, /#1 tvly-tes\.\.\.aaaa — active, remaining=1000/);
      assert.match(status.content[0].text, /#2 tvly-tes\.\.\.bbbb — active, remaining=900/);

      // Next search goes to the revived aaaa.
      const second = await client.callTool({ name: "tavily_search", arguments: { query: "second" } });
      assert.equal(second.isError, undefined);
      assert.equal(
        fakeTavily.requests.filter((r) => r.path === "/search").map((r) => r.apiKey)[1],
        "tvly-test-key-aaaa",
      );
    });
  } finally {
    await fakeTavily.close();
  }
});

test("usage 探测被 429 限流时不影响数据面（key 保持可用）", async () => {
  const fakeTavily = await startFakeTavily(async (requestRecord, response) => {
    if (requestRecord.path === "/usage") {
      // 观测面被限流
      sendJson(response, 429, { detail: { error: "excessive requests" } });
      return;
    }
    sendJson(response, 200, {
      query: requestRecord.body?.query,
      results: [{ title: "Data plane OK", url: "https://example.com", content: "ok", score: 1 }],
    });
  });

  try {
    await withMcpClient(fakeTavily.baseUrl, ["tvly-test-key-aaaa"], async (client) => {
      // 启动 preflight：/usage 429 → 状态 unknown → key 保持 active
      const search = await client.callTool({ name: "tavily_search", arguments: { query: "data plane" } });
      assert.equal(search.isError, undefined);
      assert.match(search.content[0].text, /Data plane OK/);
      assert.deepEqual(
        fakeTavily.requests.filter((r) => r.path === "/search").map((r) => r.apiKey),
        ["tvly-test-key-aaaa"],
      );

      const status = await client.callTool({ name: "tavily_key_status", arguments: {} });
      assert.match(status.content[0].text, /active/);
      assert.doesNotMatch(status.content[0].text, /cooldown/);
    });
  } finally {
    await fakeTavily.close();
  }
});

test("所有 Key 不可用时不做多余探测，refresh 后自愈", async () => {
  let exhausted = true;
  const fakeTavily = await startFakeTavily(async (requestRecord, response) => {
    if (requestRecord.path === "/usage") {
      const usage = exhausted ? 1000 : 0;
      sendJson(response, 200, {
        key: { usage, limit: 1000 },
        account: { plan_usage: usage, plan_limit: 1000 },
      });
      return;
    }

    if (requestRecord.path === "/search" && exhausted) {
      sendJson(response, 432, { detail: { error: "quota exhausted" } });
      return;
    }

    sendJson(response, 200, {
      query: requestRecord.body?.query,
      results: [{ title: "Self-healed", url: "https://example.com", content: "ok", score: 1 }],
    });
  });

  try {
    await withMcpClient(fakeTavily.baseUrl, ["tvly-test-key-aaaa"], async (client) => {
      // Startup probe marks the only key exhausted. Search fails; probe
      // knowledge is fresh (<10min) so the lazy re-probe guard must NOT fire.
      const first = await client.callTool({ name: "tavily_search", arguments: { query: "first" } });
      assert.equal(first.isError, true);
      assert.match(first.content[0].text, /No available Tavily API keys/);
      assert.equal(
        fakeTavily.requests.filter((r) => r.path === "/usage").length,
        1,
      ); // startup only — no extra probe, no /search hit
      assert.equal(fakeTavily.requests.filter((r) => r.path === "/search").length, 0);

      // Quota resets server-side; explicit refresh revives the pool.
      exhausted = false;
      const status = await client.callTool({ name: "tavily_key_status", arguments: { refresh: true } });
      assert.match(status.content[0].text, /#1 tvly-tes\.\.\.aaaa — active, remaining=1000/);

      const second = await client.callTool({ name: "tavily_search", arguments: { query: "second" } });
      assert.equal(second.isError, undefined);
      assert.deepEqual(
        fakeTavily.requests.filter((r) => r.path === "/search").map((r) => r.apiKey),
        ["tvly-test-key-aaaa"],
      );
    });
  } finally {
    await fakeTavily.close();
  }
});
