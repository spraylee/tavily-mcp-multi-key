// Regression tests for issue #2: the stdio server must never outlive its
// host. Covers stdin EOF, SIGTERM/SIGINT/SIGHUP, and the daily re-probe timer
// keeping the event loop alive after the host is gone.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = path.join(projectRoot, "build/index.js");

const EXIT_TIMEOUT_MS = 10_000;

async function startFakeTavily() {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, path: request.url });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      key: { usage: 0, limit: null },
      account: { plan_usage: 0, plan_limit: 1000 },
    }));
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

function baseEnv(baseUrl) {
  return {
    ...process.env,
    TAVILY_API_KEYS: "tvly-lifecycle-test-key",
    TAVILY_API_KEY: "",
    TAVILY_API_BASE_URL: baseUrl,
  };
}

async function startServer(env) {
  const child = spawn(process.execPath, [serverEntry], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk.toString("utf8")));
  // Resolve once the server prints its ready line (probe finished, transport
  // connected, lifecycle hooks installed).
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${stderr.join("")}`)), 10_000);
    const onData = (chunk) => {
      if (chunk.toString("utf8").includes("running on stdio")) {
        clearTimeout(timer);
        child.stderr.off("data", onData);
        resolve();
      }
    };
    child.stderr.on("data", onData);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (code=${code} signal=${signal}):\n${stderr.join("")}`));
    });
  });
  return { child, stderr };
}

function waitForExit(child, stderrRef) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`server did not exit within ${EXIT_TIMEOUT_MS}ms${stderrRef ? `:\n${stderrRef.join("")}` : ""}`)),
      EXIT_TIMEOUT_MS,
    );
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

test("宿主关闭 stdin（EOF）后 server 立即退出", async () => {
  const fakeTavily = await startFakeTavily();
  try {
    const { child, stderr } = await startServer(baseEnv(fakeTavily.baseUrl));
    child.stdin.end();
    const { code } = await waitForExit(child, stderr);
    assert.equal(code, 0);
    assert.match(stderr.join(""), /shutting down \(stdin end\)/);
  } finally {
    await fakeTavily.close();
  }
});

test("SIGTERM 触发干净退出（exit 0）", async () => {
  const fakeTavily = await startFakeTavily();
  try {
    const { child, stderr } = await startServer(baseEnv(fakeTavily.baseUrl));
    child.kill("SIGTERM");
    const { code } = await waitForExit(child, stderr);
    assert.equal(code, 0);
    assert.match(stderr.join(""), /shutting down \(SIGTERM\)/);
  } finally {
    await fakeTavily.close();
  }
});

test("SIGINT 触发干净退出（exit 0）", async () => {
  const fakeTavily = await startFakeTavily();
  try {
    const { child, stderr } = await startServer(baseEnv(fakeTavily.baseUrl));
    child.kill("SIGINT");
    const { code } = await waitForExit(child, stderr);
    assert.equal(code, 0);
    assert.match(stderr.join(""), /shutting down \(SIGINT\)/);
  } finally {
    await fakeTavily.close();
  }
});

test("SIGHUP 触发干净退出（exit 0）", async () => {
  const fakeTavily = await startFakeTavily();
  try {
    const { child, stderr } = await startServer(baseEnv(fakeTavily.baseUrl));
    child.kill("SIGHUP");
    const { code } = await waitForExit(child, stderr);
    assert.equal(code, 0);
    assert.match(stderr.join(""), /shutting down \(SIGHUP\)/);
  } finally {
    await fakeTavily.close();
  }
});

test("宿主死亡（stdin 保持打开）时孤儿自查退出", async () => {
  const fakeTavily = await startFakeTavily();
  const pidFile = path.join(projectRoot, "build", `.orphan-test-${process.pid}.pid`);
  try {
    // Simulate an abandoned server: the host dies (so we get re-parented)
    // but our stdin write end is held open by an unrelated long-lived
    // process (`sleep`), so EOF never arrives. Only the ppid self-check can
    // save us here — this is exactly the macOS orphan pile-up from issue #2.
    const env = { ...baseEnv(fakeTavily.baseUrl), TAVILY_ORPHAN_CHECK_MS: "500" };
    const wrapperScript = `
      const { spawn } = require("node:child_process");
      const fs = require("node:fs");
      const holder = spawn("sleep", ["25"], { stdio: ["ignore", "pipe", "ignore"] });
      const server = spawn(process.execPath, [${JSON.stringify(serverEntry)}], {
        env: ${JSON.stringify(env)},
        stdio: [holder.stdout, "ignore", "pipe"],
      });
      let ready = false;
      server.stderr.on("data", (chunk) => {
        if (!ready && chunk.toString("utf8").includes("running on stdio")) {
          ready = true;
          // Real hosts live for a while before dying; only exit AFTER the
          // server booted, so its ppid snapshot captured the real host.
          setTimeout(() => process.exit(0), 300);
        }
      });
      server.on("error", () => {});
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(server.pid));
    `;
    const wrapper = spawn(process.execPath, ["-e", wrapperScript], {
      env,
      stdio: ["ignore", "ignore", "ignore"],
    });
    await once(wrapper, "exit");

    // Wait for the wrapper to have written the PID file (it writes before
    // exiting, but be defensive about fs timing).
    let orphanPid = undefined;
    for (let i = 0; i < 50 && orphanPid === undefined; i += 1) {
      try {
        orphanPid = Number.parseInt(await fs.readFile(pidFile, "utf8"), 10);
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.ok(Number.isInteger(orphanPid), "wrapper should report the orphan PID");

    const isAlive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return error.code === "EPERM";
      }
    };
    assert.ok(isAlive(orphanPid), "orphan should be alive right after host death");

    // The re-parented server must exit on its own within the check window
    // (500ms interval; allow a generous margin for slow CI).
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && isAlive(orphanPid)) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(!isAlive(orphanPid), "orphaned server should exit after its parent died");
  } finally {
    await fs.rm(pidFile, { force: true }).catch(() => {});
    await fakeTavily.close();
  }
});
