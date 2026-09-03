#!/usr/bin/env python3
"""E2E test for the Rust tavily-mcp-multi-key server.

Spins up a fake Tavily HTTP API, then drives the real binary over stdio MCP:
  1. initialize handshake + tools/list (6 tools advertised)
  2. key ordering after startup probe (key with more remaining first)
  3. key rotation on 432 (exhausted → next key serves)
  4. search result formatting parity
  5. stdin EOF → clean exit 0 (issue #2 layer 1)
  6. orphan self-check: parent death → exit (issue #2 layer 3)
"""
import json
import os
import signal
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = os.path.join(REPO, "target", "release", "tavily-mcp-multi-key")
PORT = 18733
BASE = f"http://127.0.0.1:{PORT}"

# key with LOW remaining is KEY1; KEY2 has high remaining → should be first
KEYS = {"tvly-KEY111111111": 30, "tvly-KEY222222222": 950}
SEARCH_COUNT = {"n": 0}
LAST_AUTH = {"value": None}


class FakeTavily(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _json(self, obj, status=200, headers=None):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/usage":
            auth = self.headers.get("authorization", "")
            LAST_AUTH["value"] = auth
            key = auth.replace("Bearer ", "")
            remaining = KEYS.get(key, 0)
            # key-level usage present for both; KEY-level limit for KEY2 only
            # to exercise the account fallback path for KEY1.
            if key == "tvly-KEY222222222":
                self._json({"key": {"usage": 50, "limit": 1000},
                            "account": {"plan_usage": 1, "plan_limit": 2}})
            else:
                self._json({"key": {"usage": 5, "limit": None},
                            "account": {"plan_usage": 970, "plan_limit": 1000}})
            return
        self._json({"error": "not found"}, 404)

    def do_POST(self):
        length = int(self.headers.get("content-length", 0))
        payload = json.loads(self.rfile.read(length) or b"{}")
        auth = self.headers.get("authorization", "")
        key = auth.replace("Bearer ", "")

        if self.path == "/search":
            if key not in KEYS:
                self._json({"detail": f"bad key {key}"}, 401)
                return
            SEARCH_COUNT["n"] += 1
            # KEY1 pretends exhausted (432) → force rotation to KEY2
            if key == "tvly-KEY111111111":
                self._json({"detail": "quota exceeded"}, 432)
                return
            self._json({
                "query": payload.get("query", ""),
                "answer": "Rust is fast",
                "results": [{
                    "title": "Rust MCP",
                    "url": "https://example.com/rust",
                    "content": "A rewrite",
                    "score": 0.9,
                }],
            })
            return

        self._json({"detail": "unknown endpoint"}, 404)


def start_fake_api():
    server = ThreadingHTTPServer(("127.0.0.1", PORT), FakeTavily)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class McpClient:
    def __init__(self, env=None):
        self.proc = subprocess.Popen(
            [BIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, bufsize=1,
            env={**os.environ, **(env or {})},
        )
        self._id = 0

    def send(self, obj):
        self.proc.stdin.write(json.dumps(obj) + "\n")
        self.proc.stdin.flush()

    def request(self, method, params=None):
        self._id += 1
        self.send({"jsonrpc": "2.0", "id": self._id, "method": method,
                   "params": params or {}})
        return self._response(self._id)

    def notify(self, method, params=None):
        self.send({"jsonrpc": "2.0", "method": method, "params": params or {}})

    def _response(self, want_id, timeout=15):
        deadline = time.time() + timeout
        while time.time() < deadline:
            line = self._readline_deadline(deadline)
            if line is None:
                raise TimeoutError("no MCP response")
            msg = json.loads(line)
            if msg.get("id") == want_id:
                return msg
        raise TimeoutError(f"no response for id {want_id}")

    def _readline_deadline(self, deadline):
        # simple blocking read with timeout via thread
        result = [None]
        def reader():
            line = self.proc.stdout.readline()
            if line:
                result[0] = line
        t = threading.Thread(target=reader, daemon=True)
        t.start()
        t.join(max(0.1, deadline - time.time()))
        return result[0]

    def close_stdin(self):
        self.proc.stdin.close()

    def wait(self, timeout=10):
        return self.proc.wait(timeout=timeout)


def test_1_handshake_and_tools(client):
    resp = client.request("initialize", {
        "protocolVersion": "2025-06-18",
        "capabilities": {},
        "clientInfo": {"name": "e2e", "version": "0.0.1"},
    })
    info = resp["result"]["serverInfo"]
    assert info["name"] == "tavily-mcp-multi-key", info
    client.notify("notifications/initialized")
    resp = client.request("tools/list")
    tools = resp["result"]["tools"]
    names = [t["name"] for t in tools]
    expected = ["tavily_search", "tavily_extract", "tavily_crawl",
                "tavily_map", "tavily_research", "tavily_key_status"]
    assert names == expected, names
    print("  [1] handshake + 6 tools advertised  ✓")


def test_2_probe_ordering(client):
    # After startup probe, KEY2 (950 left) must rank before KEY1 (30 left).
    resp = client.request("tools/call", {"name": "tavily_key_status", "arguments": {}})
    text = resp["result"]["content"][0]["text"]
    lines = [l for l in text.splitlines() if l.startswith("#")]
    assert "...2222" in lines[0] and "remaining=950" in lines[0], lines
    assert "...1111" in lines[1] and "remaining=30" in lines[1], lines
    print(f"  [2] probe ordering (high-remaining first)  ✓")


def test_3_rotation_on_432(client):
    before = SEARCH_COUNT["n"]
    resp = client.request("tools/call", {
        "name": "tavily_search",
        "arguments": {"query": "rust mcp"},
    })
    result = resp["result"]
    text = result["content"][0]["text"]
    # KEY1 exhausted (432) → rotated to KEY2 → success
    assert "Rust is fast" in text, text
    assert not result.get("isError"), result
    assert SEARCH_COUNT["n"] == before + 1
    print("  [3] 432 rotation: KEY1 exhausted → KEY2 served  ✓")


def test_4_search_parity(client):
    resp = client.request("tools/call", {
        "name": "tavily_search",
        "arguments": {"query": "parity", "include_domains": [], "topic": None},
    })
    text = resp["result"]["content"][0]["text"]
    assert text.startswith("Answer: Rust is fast"), text[:60]
    assert "Detailed Results:" in text
    assert "Title: Rust MCP" in text
    assert "URL: https://example.com/rust" in text
    print("  [4] search output formatting parity  ✓")


def test_5_stdin_eof_exit():
    client = McpClient(env=ENV)
    client.request("initialize", {"protocolVersion": "2025-06-18",
                                  "capabilities": {},
                                  "clientInfo": {"name": "e2e", "version": "0"}})
    client.notify("notifications/initialized")
    time.sleep(0.3)
    t0 = time.time()
    client.close_stdin()
    code = client.wait(5)
    elapsed = time.time() - t0
    assert code == 0, f"exit code {code}"
    assert elapsed < 3, f"exit took {elapsed:.1f}s"
    print(f"  [5] stdin EOF → exit 0 in {elapsed:.2f}s  ✓")


def test_6_orphan_exit():
    # Parent (this python) spawns an intermediate bash that SPAWNS the server
    # as its child (no exec — the bash must stay alive as the middle layer).
    # Kill the bash → server is re-parented → ppid changes → orphan check fires.
    wrapper = subprocess.Popen(
        ["bash", "-c", f"sleep 0.2; {BIN}; sleep 30"],
        stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, env={**os.environ, **ENV,
                                        "TAVILY_ORPHAN_CHECK_MS": "500"},
        start_new_session=True,
    )
    # stdin stays open (pipe held by this python process, never written) so the
    # server sees no EOF — only the ppid orphan check can take it down.
    time.sleep(1.5)  # let the server boot + snapshot its ppid (the bash)
    out = subprocess.check_output(
        ["bash", "-c", f"pgrep -f 'target/release/tavily-mcp-multi-key$' | grep -v {wrapper.pid} || true"]
    ).decode().split()
    assert out, "server process not found"
    server_pid = int(out[0])
    # sanity: the server's parent must be the wrapper bash right now
    ppid = subprocess.check_output(
        ["bash", "-c", f"awk '/^PPid/ {{print $2}}' /proc/{server_pid}/status"]
    ).decode().strip()
    assert int(ppid) == wrapper.pid, f"unexpected parent {ppid} != {wrapper.pid}"

    t0 = time.time()
    wrapper.kill()  # middle layer dies → server re-parented to init/subreaper
    wrapper.wait()
    # the trailing `sleep 30` keeps the session alive so the server truly is
    # orphaned rather than killed along with the bash
    deadline = time.time() + 6
    while time.time() < deadline:
        try:
            os.kill(server_pid, 0)  # still alive?
        except ProcessLookupError:
            break
        time.sleep(0.1)
    else:
        os.kill(server_pid, signal.SIGKILL)
        raise AssertionError("server did NOT exit after parent death — orphan leak!")
    elapsed = time.time() - t0
    assert elapsed < 4, f"orphan exit too slow: {elapsed:.1f}s"
    print(f"  [6] orphan self-check → exit in {elapsed:.1f}s  ✓")


if __name__ == "__main__":
    ENV = {
        "TAVILY_API_KEYS": ",".join(KEYS),
        "TAVILY_API_BASE_URL": BASE,
        "TAVILY_REPROBE_TICK_MS": "60000",
        "TAVILY_ORPHAN_CHECK_MS": "60000",
    }
    server = start_fake_api()
    print("E2E: Rust tavily-mcp-multi-key vs fake Tavily API")
    client = McpClient(env=ENV)
    try:
        test_1_handshake_and_tools(client)
        test_2_probe_ordering(client)
        test_3_rotation_on_432(client)
        test_4_search_parity(client)
    finally:
        client.proc.kill()
    test_5_stdin_eof_exit()
    test_6_orphan_exit()
    print("\nALL E2E PASSED ★")
