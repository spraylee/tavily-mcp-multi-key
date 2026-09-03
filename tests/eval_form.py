#!/usr/bin/env python3
"""E2E for the README's eval-form bootstrap command.

Runs exactly `sh -c 'eval "$(curl .../bootstrap.sh)"'` against a local HTTP
fixture and proves: stdin stays the JSON-RPC channel, the handshake succeeds,
and the process exec-replaces into the native Rust binary.
"""
import hashlib
import http.server
import json
import os
import selectors
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
VERSION = "v0.4.0"
TARGET = "x86_64-unknown-linux-gnu"


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="eval-e2e-") as td:
        tmp = Path(td)
        release = tmp / "release"
        release.mkdir()
        # Serve bootstrap.sh through the same latest-download URL shape the
        # README uses, so this test mirrors the real configuration exactly.
        latest_dir = tmp / "releases" / "latest" / "download"
        latest_dir.mkdir(parents=True)
        shutil.copy2(REPO / "scripts" / "bootstrap.sh", latest_dir / "bootstrap.sh")
        asset = f"tavily-mcp-multi-key-{VERSION}-{TARGET}.tar.gz"
        with tarfile.open(release / asset, "w:gz") as tar:
            tar.add(REPO / "target" / "release" / "tavily-mcp-multi-key",
                    arcname="tavily-mcp-multi-key")
        digest = hashlib.sha256((release / asset).read_bytes()).hexdigest()
        (release / "SHA256SUMS").write_text(f"{digest}  {asset}\n")

        server = http.server.ThreadingHTTPServer(
            ("127.0.0.1", 0), lambda *a, **k: Quiet(*a, directory=str(tmp), **k))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{server.server_port}"

        # The exact launch shape documented in README.md.
        cmd = f'eval "$(curl -fsSL {base}/releases/latest/download/bootstrap.sh)"'
        env = {**os.environ,
               "TAVILY_MCP_RELEASE_BASE_URL": f"{base}/release",
               "TAVILY_MCP_VERSION": VERSION,
               "TAVILY_MCP_CACHE_DIR": str(tmp / "cache"),
               "TAVILY_API_KEYS": "",
               "TAVILY_API_KEY": "",
               "TAVILY_ORPHAN_CHECK_MS": "0"}
        proc = subprocess.Popen(["sh", "-c", cmd], cwd=REPO, env=env,
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, bufsize=1)
        try:
            proc.stdin.write(json.dumps({
                "jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                           "clientInfo": {"name": "eval-e2e", "version": "1"}}}) + "\n")
            proc.stdin.flush()
            sel = selectors.DefaultSelector()
            sel.register(proc.stdout, selectors.EVENT_READ)
            deadline = time.monotonic() + 30
            line = None
            while time.monotonic() < deadline:
                for key, _ in sel.select(0.05):
                    line = key.fileobj.readline()
                    break
                if line:
                    break
            assert line, "no MCP response"
            resp = json.loads(line)
            assert resp["result"]["serverInfo"]["version"] == VERSION[1:], resp
            exe = os.readlink(f"/proc/{proc.pid}/exe")
            assert exe.endswith("tavily-mcp-multi-key"), exe
            proc.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
            proc.stdin.flush()
            proc.stdin.close()
            assert proc.wait(timeout=8) == 0
            print("EVAL-FORM E2E PASS — exec ->", exe)
        finally:
            if proc.poll() is None:
                proc.kill()
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
