#!/usr/bin/env node
/**
 * postinstall: replace the JS launcher with the platform binary (esbuild-style).
 *
 * Why: `spawnSync` in launcher.js keeps a ~44MB node process alive for the
 * whole server lifetime. Overwriting the installed launcher with the actual
 * ELF binary lets npm's .bin entry exec it directly — zero node overhead.
 *
 * POSIX : the .bin entry is a symlink to npm/launcher.js; after we overwrite
 *         that file with the ELF binary, execve handles it natively (shebangs
 *         are only needed for scripts).
 * Windows: npm's .cmd shim invokes `node launcher.js`; overwriting would break
 *          it, so instead we rewrite the .cmd shim to invoke the .exe directly.
 *
 * Every failure path degrades gracefully to the working JS launcher.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const MAP = {
  darwin: { arm64: "darwin-arm64", x64: "darwin-x64" },
  linux: { arm64: "linux-arm64", x64: "linux-x64" },
  win32: { arm64: "win32-arm64", x64: "win32-x64" },
};

function main() {
  const pkgRoot = path.join(__dirname, "..");
  const dir = MAP[process.platform] && MAP[process.platform][process.arch];
  if (!dir) {
    console.error("[tavily-mcp-multi-key] postinstall: unsupported platform, keeping JS launcher");
    return;
  }
  const exeName = process.platform === "win32" ? "tavily-mcp-multi-key.exe" : "tavily-mcp-multi-key";
  const src = path.join(pkgRoot, "bin", dir, exeName);
  if (!fs.existsSync(src)) {
    console.error(`[tavily-mcp-multi-key] postinstall: binary missing at bin/${dir}/${exeName}, keeping JS launcher`);
    return;
  }

  try {
    if (process.platform === "win32") {
      // Rewrite the generated .cmd shim to invoke the exe directly.
      const binDir = path.join(pkgRoot, "..", "..", ".bin");
      const cmd = path.join(binDir, "tavily-mcp-multi-key.cmd");
      if (fs.existsSync(binDir) && fs.existsSync(cmd)) {
        const rel = path.relative(binDir, src);
        fs.writeFileSync(cmd, `@ECHO off\r\n"%~dp0\\${rel.replace(/\//g, "\\")}" %*\r\n`, "utf8");
        console.log("[tavily-mcp-multi-key] postinstall: cmd shim -> native exe");
      }
    } else {
      const target = path.join(pkgRoot, "npm", "launcher.js");
      fs.copyFileSync(src, target);
      fs.chmodSync(target, 0o755);
      console.log(`[tavily-mcp-multi-key] postinstall: launcher -> ${dir} native binary`);
    }
  } catch (error) {
    console.error("[tavily-mcp-multi-key] postinstall failed, keeping JS launcher:", error.message);
  }
}

main();
