#!/usr/bin/env python3
"""Deep-diff the tavily_search schema between Node and Rust."""
import json, os, subprocess, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(__file__))
from bench import FakeTavily, PORT, ENV, spawn, mcp_roundtrip
from parity import get_tools


def deep_diff(a, b, path=""):
    diffs = []
    if type(a) != type(b):
        return [f"{path}: 类型 {type(a).__name__} vs {type(b).__name__}"]
    if isinstance(a, dict):
        for k in a.keys() | b.keys():
            if k not in a:
                diffs.append(f"{path}.{k}: Rust 独有 = {json.dumps(b[k])[:120]}")
            elif k not in b:
                diffs.append(f"{path}.{k}: Node 独有 = {json.dumps(a[k])[:120]}")
            else:
                diffs += deep_diff(a[k], b[k], f"{path}.{k}")
    elif isinstance(a, list):
        if len(a) != len(b):
            diffs.append(f"{path}: 长度 {len(a)} vs {len(b)}")
        for i, (x, y) in enumerate(zip(a, b)):
            diffs += deep_diff(x, y, f"{path}[{i}]")
    elif a != b:
        diffs.append(f"{path}: {json.dumps(a)[:100]} vs {json.dumps(b)[:100]}")
    return diffs


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), FakeTavily)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    node_tools = get_tools(["/root/.hermes/node/bin/npx", "-y",
                            "@spraylee/tavily-mcp-multi-key@latest"])
    rust_tools = get_tools(["/root/.openclaw/workspace/tavily-mcp-multi-key/rust/target/release/tavily-mcp-multi-key"])

    n = next(t for t in node_tools if t["name"] == "tavily_search")
    r = next(t for t in rust_tools if t["name"] == "tavily_search")
    for d in deep_diff(n["inputSchema"], r["inputSchema"], "schema"):
        print(d)
    print("（无输出 = 完全一致）")
