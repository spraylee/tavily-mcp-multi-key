#!/usr/bin/env node
/**
 * Launcher for @spraylee/tavily-mcp-multi-key.
 *
 * v0.3.0+ ships a prebuilt Rust binary per platform inside this package
 * (npm/install/bin/<platform>/<arch>/tavily-mcp-multi-key). This launcher
 * resolves the right binary for the current platform and execs it, so
 * existing users keep the exact same `npx @spraylee/tavily-mcp-multi-key`
 * experience with zero config changes.
 *
 * Platform-in-source layouts follow the esbuild convention.
 */

"use strict";

const { spawnSync } = require("child_process");
const path = require("path");

const PLATFORM_MAP = {
  // os: { arch: dir }
  darwin: { arm64: "darwin-arm64", x64: "darwin-x64" },
  linux: { arm64: "linux-arm64", x64: "linux-x64" },
  win32: { arm64: "win32-arm64", x64: "win32-x64" },
};

function resolveBinary() {
  const arch = PLATFORM_MAP[process.platform]?.[process.arch];
  if (!arch) {
    return null;
  }
  const exe = process.platform === "win32" ? "tavily-mcp-multi-key.exe" : "tavily-mcp-multi-key";
  return path.join(__dirname, "..", "bin", arch, exe);
}

function main() {
  const bin = resolveBinary();
  if (!bin || !require("fs").existsSync(bin)) {
    const tried = bin || `${process.platform}/${process.arch}`;
    console.error(
      `[tavily-mcp-multi-key] no prebuilt binary for ${tried}. ` +
        "Please open an issue at https://github.com/spraylee/tavily-mcp-multi-key/issues " +
        "with your platform/arch — or build from source (cargo build --release in rust/)."
    );
    process.exit(1);
  }

  const result = spawnSync(bin, process.argv.slice(2), {
    stdio: "inherit",
    // Windows: spawn the exe directly; POSIX: exec semantics via spawn.
    ...(process.platform === "win32" ? {} : { execArgv: [] }),
  });

  if (result.error) {
    console.error("[tavily-mcp-multi-key] failed to launch binary:", result.error.message);
    process.exit(1);
  }
  process.exit(result.status ?? 0);
}

main();
