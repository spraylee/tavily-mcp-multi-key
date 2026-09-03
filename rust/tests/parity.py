#!/usr/bin/env python3
"""Diff tools/list JSON between Node and Rust servers (schema parity check)."""
import json, os, subprocess, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(__file__))
from bench import FakeTavily, PORT, ENV, spawn, mcp_roundtrip


def get_tools(cmd):
    proc = spawn(cmd)
    mcp_roundtrip(proc, "initialize", {"protocolVersion": "2025-06-18",
                                      "capabilities": {},
                                      "clientInfo": {"name": "diff", "version": "0"}})
    proc.stdin.write(json.dumps({"jsonrpc": "2.0",
                                 "method": "notifications/initialized"}) + "\n")
    proc.stdin.flush()
    resp = mcp_roundtrip(proc, "tools/list", {})
    proc.kill()
    return resp["result"]["tools"]


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), FakeTavily)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    node_tools = get_tools(["/root/.hermes/node/bin/npx", "-y",
                            "@spraylee/tavily-mcp-multi-key@latest"])
    rust_tools = get_tools(["/root/.openclaw/workspace/tavily-mcp-multi-key/rust/target/release/tavily-mcp-multi-key"])

    print(f"tools 数量: Node={len(node_tools)} Rust={len(rust_tools)}")
    diffs = 0
    for n, r in zip(node_tools, rust_tools):
        if n["name"] != r["name"]:
            print(f"  ✗ 名称不同: {n['name']} vs {r['name']}"); diffs += 1; continue
        if n.get("description") != r.get("description"):
            print(f"  ✗ {n['name']}: description 不一致"); diffs += 1
        if n.get("inputSchema") != r.get("inputSchema"):
            # find exact keys differing
            ns, rs = n.get("inputSchema", {}), r.get("inputSchema", {})
            for k in set(ns) | set(rs):
                if ns.get(k) != rs.get(k):
                    print(f"  ✗ {n['name']}.inputSchema.{k} 不一致")
                    print(f"     Node: {json.dumps(ns.get(k), ensure_ascii=False)[:200]}")
                    print(f"     Rust: {json.dumps(rs.get(k), ensure_ascii=False)[:200]}")
                    diffs += 1
        else:
            print(f"  ✓ {n['name']}: schema 完全一致")
    print(f"\n结果: {'PARITY ✓✓' if diffs == 0 else f'{diffs} 处差异'}")
