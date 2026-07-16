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
        ["tavily_search", "tavily_extract", "tavily_crawl", "tavily_map", "tavily_research"],
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
