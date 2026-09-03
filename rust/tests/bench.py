#!/usr/bin/env python3
"""Benchmark: Rust binary vs Node npx for tavily-mcp-multi-key.

Measures (both against a local fake Tavily API so no network variance):
  1. cold start → first response (initialize round-trip)
  2. steady-state RSS after handshake + 1 search
  3. binary / install footprint
"""
import json
import os
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

RUST_BIN = "/root/.openclaw/workspace/tavily-mcp-multi-key/rust/target/release/tavily-mcp-multi-key"
PORT = 18744
BASE = f"http://127.0.0.1:{PORT}"


class FakeTavily(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/usage":
            self._json({"key": {"usage": 10, "limit": 1000},
                        "account": {"plan_usage": 10, "plan_limit": 1000}})
        else:
            self._json({}, 404)

    def do_POST(self):
        if self.path == "/search":
            self._json({"query": "x", "answer": "ok", "results": [
                {"title": "t", "url": "https://e.com", "content": "c", "score": 1}]})
        else:
            self._json({}, 404)


ENV = {
    **os.environ,
    "TAVILY_API_KEYS": "tvly-bench1,tvly-bench2",
    "TAVILY_API_BASE_URL": BASE,
    "TAVILY_ORPHAN_CHECK_MS": "60000",
}


def spawn(cmd):
    return subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, text=True, bufsize=1, env=ENV)


def mcp_roundtrip(proc, method, params, _id=[0]):
    _id[0] += 1
    proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": _id[0],
                                 "method": method, "params": params}) + "\n")
    proc.stdin.flush()
    while True:
        line = proc.stdout.readline()
        if not line:
            raise RuntimeError("eof")
        msg = json.loads(line)
        if msg.get("id") == _id[0]:
            return msg


def rss_kb(pid):
    with open(f"/proc/{pid}/status") as f:
        for line in f:
            if line.startswith("VmRSS:"):
                return int(line.split()[1])
    return 0


def tree_rss_kb(root_pid):
    """Total RSS of a process tree (npx spawns npm+sh+node)."""
    total, frontier = 0, [root_pid]
    while frontier:
        pid = frontier.pop()
        try:
            total += rss_kb(pid)
            children = subprocess.check_output(
                ["pgrep", "-P", str(pid)]).decode().split()
            frontier.extend(int(c) for c in children)
        except Exception:
            pass
    return total


def bench(name, cmd, is_tree):
    print(f"\n--- {name} ---")
    starts, steadies = [], []
    for i in range(5):
        t0 = time.perf_counter()
        proc = spawn(cmd)
        resp = mcp_roundtrip(proc, "initialize", {
            "protocolVersion": "2025-06-18", "capabilities": {},
            "clientInfo": {"name": "bench", "version": "0"}})
        assert "serverInfo" in resp["result"]
        proc.stdin.write(json.dumps({"jsonrpc": "2.0",
                                     "method": "notifications/initialized"}) + "\n")
        proc.stdin.flush()
        starts.append((time.perf_counter() - t0) * 1000)
        # one search to warm pools
        mcp_roundtrip(proc, "tools/call", {
            "name": "tavily_search", "arguments": {"query": "warm"}})
        time.sleep(0.4)  # let allocs settle
        rss = tree_rss_kb(proc.pid) if is_tree else rss_kb(proc.pid)
        steadies.append(rss)
        proc.kill()
        proc.wait()
    starts.sort(), steadies.sort()
    med_s = starts[2]
    med_rss = steadies[2]
    print(f"  cold start→init: med {med_s:.0f}ms  (runs: {[f'{x:.0f}' for x in starts]})")
    print(f"  steady RSS:      med {med_rss/1024:.1f} MB  (runs: {[f'{x/1024:.1f}' for x in steadies]})")
    return med_s, med_rss


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), FakeTavily)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    node_cmd = ["/root/.hermes/node/bin/npx", "-y", "@spraylee/tavily-mcp-multi-key@latest"]
    rust_cmd = [RUST_BIN]

    ns, nr = bench("Node (npx @spraylee/tavily-mcp-multi-key)", node_cmd, is_tree=True)
    rs, rr = bench("Rust (static binary)", rust_cmd, is_tree=False)

    print("\n================ 汇总 ================")
    print(f"启动→就绪:   Node {ns:.0f}ms  vs  Rust {rs:.0f}ms   ({ns/rs:.0f}x)")
    print(f"常驻内存:    Node {nr/1024:.1f}MB  vs  Rust {rr/1024:.1f}MB   (省 {(nr-rr)/1024:.1f}MB, -{(1-rr/nr)*100:.0f}%)")
    node_pkg = subprocess.run(["du", "-sh", "/root/.npm/_npx/af0353b4917b30f5"],
                              capture_output=True, text=True).stdout.split()[0]
    print(f"磁盘占用:    Node npx 缓存 {node_pkg}  vs  Rust 单文件 {os.path.getsize(RUST_BIN)/1048576:.1f}MB")
