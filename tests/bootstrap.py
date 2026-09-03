#!/usr/bin/env python3
"""Black-box test for the GitHub Release shell bootstrapper.

The test serves a release archive and checksum from a local HTTP server. It
proves that the bootstrapper downloads once, verifies/extracts/caches the
binary, preserves the caller's MCP stdin, and exec-replaces the shell so the
long-lived process is the Rust binary rather than a wrapper.
"""
from __future__ import annotations

import hashlib
import http.server
import json
import os
import selectors
import shlex
import shutil
import subprocess
import tarfile
import tempfile
import threading
import time
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
SCRIPT = REPO / "scripts" / "bootstrap.sh"
BINARY = REPO / "target" / "release" / "tavily-mcp-multi-key"
VERSION = "v0.4.1"
TARGET = "x86_64-unknown-linux-gnu"
PLATFORM_TARGETS = {
    "Linux x64": TARGET,
    "macOS arm64": "aarch64-apple-darwin",
    "macOS x64": "x86_64-apple-darwin",
}


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        # GitHub-style latest-download redirect: 302 whose Location embeds
        # the resolved release tag. The version probe parses this Location.
        if self.path == "/releases/latest/download/SHA256SUMS":
            tag = self.server.latest_tag  # type: ignore[attr-defined]
            self.send_response(302)
            self.send_header(
                "Location",
                f"/releases/download/{tag}/SHA256SUMS",
            )
            self.end_headers()
            return
        super().do_GET()


def start_server(directory: Path):
    handler = lambda *args, **kwargs: QuietHandler(*args, directory=str(directory), **kwargs)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    server.latest_tag = VERSION  # type: ignore[attr-defined]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


def request(proc: subprocess.Popen[str], payload: dict, timeout: float = 30) -> dict:
    proc.stdin.write(json.dumps(payload, separators=(",", ":")) + "\n")
    proc.stdin.flush()
    selector = selectors.DefaultSelector()
    selector.register(proc.stdout, selectors.EVENT_READ)
    deadline = time.monotonic() + timeout
    try:
        while time.monotonic() < deadline:
            events = selector.select(max(0.05, deadline - time.monotonic()))
            for key, _ in events:
                line = key.fileobj.readline()
                if line:
                    return json.loads(line)
        raise AssertionError("MCP response timeout")
    finally:
        selector.close()


def start_process(argv: list[str], env: dict[str, str]) -> subprocess.Popen[str]:
    return subprocess.Popen(
        argv,
        cwd=REPO,
        env={**os.environ, **env},
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )


def initialize(proc: subprocess.Popen[str]) -> tuple[subprocess.Popen[str], dict]:
    response = request(
        proc,
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "bootstrap-e2e", "version": "1"},
            },
        },
    )
    assert response.get("result", {}).get("serverInfo", {}).get("version") == VERSION[1:]
    return proc, response


def run_once(env: dict[str, str]) -> tuple[subprocess.Popen[str], dict]:
    proc = start_process(["sh", str(SCRIPT)], env)
    return initialize(proc)


def run_via_inline_eval(
    base_url: str, env: dict[str, str]
) -> tuple[subprocess.Popen[str], dict]:
    # The exact inline launch shape documented for MCP clients: eval with
    # command substitution keeps stdin free for the JSON-RPC channel.
    command = f'eval "$(curl -fsSL {shlex.quote(base_url + "/bootstrap.sh")})"'
    proc = start_process(["sh", "-c", command], env)
    return initialize(proc)


def close_cleanly(proc: subprocess.Popen[str]) -> None:
    proc.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
    proc.stdin.flush()
    proc.stdin.close()
    code = proc.wait(timeout=8)
    assert code == 0, f"server exit code {code}; stderr={proc.stderr.read()}"


def make_release_archive(release: Path, version: str, targets: dict[str, str]) -> dict[str, Path]:
    archives = {}
    checksum_lines = []
    asset_names = []
    for target in targets.values():
        asset = f"tavily-mcp-multi-key-{version}-{target}.tar.gz"
        archive = release / asset
        with tarfile.open(archive, "w:gz") as tar:
            tar.add(BINARY, arcname="tavily-mcp-multi-key")
        archives[target] = archive
        asset_names.append(asset)
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        checksum_lines.append(f"{digest}  {asset}")
    # Merge: keep checksum entries for assets of other versions already on disk.
    manifest = release / "SHA256SUMS"
    old_lines = manifest.read_text().splitlines() if manifest.exists() else []
    keep = [ln for ln in old_lines if not any(asset_name in ln for asset_name in asset_names)]
    manifest.write_text("\n".join(keep + checksum_lines) + "\n")
    return archives


def main() -> None:
    assert SCRIPT.exists(), f"missing bootstrap script: {SCRIPT}"
    assert BINARY.exists(), f"build release binary first: {BINARY}"

    with tempfile.TemporaryDirectory(prefix="bootstrap-e2e-") as tmp:
        root = Path(tmp)
        release = root / "release"
        release.mkdir()
        shutil.copy2(SCRIPT, release / "bootstrap.sh")
        archives = make_release_archive(release, VERSION, PLATFORM_TARGETS)

        server, thread = start_server(root)
        base = f"http://127.0.0.1:{server.server_port}"
        release_base = f"{base}/release"
        cache = root / "cache"
        env = {
            "TAVILY_MCP_RELEASE_BASE_URL": release_base,
            "TAVILY_MCP_VERSION": VERSION,
            "TAVILY_MCP_CACHE_DIR": str(cache),
            "TAVILY_API_KEYS": "",
            "TAVILY_API_KEY": "",
            "TAVILY_ORPHAN_CHECK_MS": "0",
        }
        proc, _ = run_once(env)
        try:
            exe = os.readlink(f"/proc/{proc.pid}/exe")
            assert exe.endswith("tavily-mcp-multi-key"), f"wrapper not exec-replaced: {exe}"
            close_cleanly(proc)
        finally:
            if proc.poll() is None:
                proc.kill()

        cached = cache / VERSION / TARGET / "tavily-mcp-multi-key"
        assert cached.is_file() and os.access(cached, os.X_OK), cached
        cached_digest = cache / VERSION / TARGET / "tavily-mcp-multi-key.sha256"
        assert cached_digest.is_file(), cached_digest

        # A downloaded cache is re-verified on every launch and repaired from
        # the release if its native binary was modified locally.
        cached.write_bytes(cached.read_bytes() + b"tampered-cache")
        repaired, _ = run_once(env)
        try:
            close_cleanly(repaired)
        finally:
            if repaired.poll() is None:
                repaired.kill()

        # Exercise both macOS target mappings without needing a macOS runner:
        # the fixture contains the same test ELF under each target name.
        fake_bin_dir = root / "fake-bin"
        fake_bin_dir.mkdir()
        fake_uname = fake_bin_dir / "uname"
        for arch, target in (("arm64", "aarch64-apple-darwin"), ("x86_64", "x86_64-apple-darwin")):
            fake_uname.write_text(f'#!/bin/sh\ncase "$1" in -s) printf \'Darwin\\n\' ;; -m) printf \'{arch}\\n\' ;; esac\n')
            fake_uname.chmod(0o755)
            platform_cache = root / "platform-cache" / target
            platform_env = {
                **env,
                "PATH": f"{fake_bin_dir}:{os.environ['PATH']}",
                "TAVILY_MCP_CACHE_DIR": str(platform_cache),
                "TAVILY_MCP_RELEASE_BASE_URL": release_base,
            }
            platform_proc, _ = run_once(platform_env)
            try:
                exe = os.readlink(f"/proc/{platform_proc.pid}/exe")
                assert exe.endswith("tavily-mcp-multi-key"), f"platform mapping did not exec binary: {exe}"
                close_cleanly(platform_proc)
            finally:
                if platform_proc.poll() is None:
                    platform_proc.kill()

        remote_proc, _ = run_via_inline_eval(
            release_base,
            {**env, "TAVILY_MCP_CACHE_DIR": str(root / "remote-cache")},
        )
        try:
            exe = os.readlink(f"/proc/{remote_proc.pid}/exe")
            assert exe.endswith("tavily-mcp-multi-key"), f"remote wrapper not exec-replaced: {exe}"
            close_cleanly(remote_proc)
        finally:
            if remote_proc.poll() is None:
                remote_proc.kill()
        inline_cache = root / "remote-cache" / VERSION / TARGET / "tavily-mcp-multi-key"
        assert inline_cache.is_file(), inline_cache

        # ---- auto-follow-latest mode ----

        auto_env = {
            **env,
            "TAVILY_MCP_VERSION": "",
            "TAVILY_MCP_LATEST_PROBE_URL": f"{base}/releases/latest/download/SHA256SUMS",
            "TAVILY_MCP_CACHE_DIR": str(root / "auto-cache"),
            "TAVILY_MCP_RELEASE_BASE_URL": release_base,
        }

        # First launch with no cache: the probe follows the 302 redirect,
        # parses the tag from Location, and installs that version.
        auto_proc, _ = run_once(auto_env)
        try:
            close_cleanly(auto_proc)
        finally:
            if auto_proc.poll() is None:
                auto_proc.kill()
        assert (root / "auto-cache" / VERSION).is_dir(), "auto mode did not install the API version"
        last_version = (root / "auto-cache" / "last-version").read_text().strip()
        assert last_version == VERSION, f"last-version={last_version}"

        # New release appears upstream: next launch installs it and drops the
        # old version directory (the exec'd binary serves as the "running" one).
        major = int(VERSION.lstrip("v").split(".")[0])
        NEW_VERSION = f"v{major + 1}.0.0"
        make_release_archive(release, NEW_VERSION, PLATFORM_TARGETS)
        server.latest_tag = NEW_VERSION  # type: ignore[attr-defined]
        upgrade_env = {**auto_env, "TAVILY_MCP_CACHE_DIR": str(root / "auto-cache")}
        upgraded, _ = run_once(upgrade_env)
        try:
            close_cleanly(upgraded)
        finally:
            if upgraded.poll() is None:
                upgraded.kill()
        assert (root / "auto-cache" / NEW_VERSION / TARGET / "tavily-mcp-multi-key").is_file(), \
            "auto mode did not install the new version"
        assert not (root / "auto-cache" / VERSION).exists(), "old version directory was not dropped"

        # API down but cache present: falls back to the last installed version.
        offline_env = {**auto_env, "TAVILY_MCP_LATEST_PROBE_URL": "http://127.0.0.1:1/nope"}
        fallback, _ = run_once(offline_env)
        try:
            close_cleanly(fallback)
        finally:
            if fallback.poll() is None:
                fallback.kill()
        assert (root / "auto-cache" / NEW_VERSION / TARGET / "tavily-mcp-multi-key").is_file()

        # A changed archive must never be installed when the manifest still
        # contains the old digest.
        archive = archives[TARGET]
        archive.write_bytes(archive.read_bytes() + b"tampered")
        rejected = subprocess.run(
            ["sh", str(SCRIPT)],
            cwd=REPO,
            env={**os.environ, **env, "TAVILY_MCP_CACHE_DIR": str(root / "bad-cache")},
            input="",
            capture_output=True,
            text=True,
            timeout=15,
        )
        assert rejected.returncode != 0
        assert "checksum mismatch" in rejected.stderr

        server.shutdown()
        server.server_close()
        thread.join(timeout=3)

        # A dead release endpoint must not matter after the first successful
        # download: the second invocation should use the cached native binary.
        proc2, _ = run_once({**env, "TAVILY_MCP_RELEASE_BASE_URL": "http://127.0.0.1:1"})
        try:
            close_cleanly(proc2)
        finally:
            if proc2.poll() is None:
                proc2.kill()

    print("BOOTSTRAP E2E PASS")


if __name__ == "__main__":
    main()
