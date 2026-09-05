# tavily-mcp-multi-key

[![Website](https://img.shields.io/badge/website-tavily--mcp.spraylee.com-c1440e?style=flat-square)](https://tavily-mcp.spraylee.com)
[![Release](https://img.shields.io/github/v/release/spraylee/tavily-mcp-multi-key?style=flat-square)](https://github.com/spraylee/tavily-mcp-multi-key/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-c1440e?style=flat-square)](LICENCE)

基于官方 Tavily MCP 的本地 stdio MCP Server，支持多个 Tavily API Key 的额度感知轮换。

**[→ 官网 tavily-mcp.spraylee.com](https://tavily-mcp.spraylee.com)** — 一页看懂多 key 轮换与各客户端配置。

本项目现在是**纯 Rust 实现**：

- 运行时只有一个原生 Rust 二进制，不依赖 Node.js、npm、npx 或 Python。
- 发布物来自 GitHub Releases，按操作系统和 CPU 架构下载预编译二进制。
- POSIX 自举脚本使用 `curl` 下载、SHA-256 校验、本地缓存，最后 `exec` 原生二进制。
- 仓库不再维护 TypeScript 版本，也不再发布 npm 包。

## 支持的工具

- `tavily_search`
- `tavily_extract`
- `tavily_crawl`
- `tavily_map`
- `tavily_research`
- `tavily_key_status`：查看 key 池状态和余额，`refresh=true` 强制重新探测

工具名称、参数 Schema 和返回格式保持官方实现兼容。

## MCP 客户端配置

### 方式一：binox 运行（推荐）

先装 [binox](https://binox.spraylee.com)（一行命令，免 Node）：

```sh
curl -fsSL https://binox.spraylee.com/sh | sh
```

然后按你的客户端三选一：

**Claude Code**（终端一行）：

```sh
claude mcp add tavily --env TAVILY_API_KEYS=key1,key2,key3 -- binox spraylee/tavily-mcp-multi-key
```

**Codex**（写入 `~/.codex/config.toml`）：

```toml
[mcp_servers.tavily]
command = "binox"
args = ["spraylee/tavily-mcp-multi-key"]
env = { TAVILY_API_KEYS = "key1,key2,key3" }
```

**通用 JSON 客户端（pi 等）**（写入 `~/.config/mcp/mcp.json`）：

```json
{
  "mcpServers": {
    "tavily": {
      "command": "binox",
      "args": ["spraylee/tavily-mcp-multi-key"],
      "env": { "TAVILY_API_KEYS": "key1,key2,key3" }
    }
  }
}
```

binox 每次启动自动探测最新 Release（探测失败回退本地缓存），运行期单进程、无 Node 常驻。想钉死版本：`args` 换成 `["spraylee/tavily-mcp-multi-key@v0.4.1"]`。

### 方式二：GitHub Release 自举（不装 binox）

下面的配置无需预装本项目，也不会让 npm/Node 常驻。每次启动会自动检查 GitHub 最新 Release：有新版本才下载（约 2MB，一次性），没有就用本地缓存秒启；GitHub 连不上时自动降级使用已装版本。

> 写法上形如 `curl xxx | sh`，但用 `eval "$(curl ...)"` 代替管道：命令替换把脚本读进内存，stdin 原封不动留给 MCP 的 JSON-RPC 通道。字面管道版会吃掉 stdin，不能用。

```json
{
  "mcpServers": {
    "tavily": {
      "command": "sh",
      "args": [
        "-c",
        "eval \"$(curl -fsSL https://github.com/spraylee/tavily-mcp-multi-key/releases/latest/download/bootstrap.sh)\""
      ],
      "env": {
        "TAVILY_API_KEYS": "key1,key2"
      }
    }
  }
}
```

一行等价写法（终端里直接测）：

```sh
TAVILY_API_KEYS="key1,key2" sh -c 'eval "$(curl -fsSL https://github.com/spraylee/tavily-mcp-multi-key/releases/latest/download/bootstrap.sh)"'
```

`releases/latest/download/` 是 GitHub 官方"始终指向最新 Release 资产"的地址，所以**不需要知道版本号**：发新版后，这份配置一个字都不用改，下次启动自动用上新版本。

想固定某个版本（CI、复现、镜像场景），给 bootstrap 设环境变量即可：

```text
TAVILY_MCP_VERSION=v0.4.1          # 留空 = 自动跟随最新；设置 vX.Y.Z = 固定版本
TAVILY_MCP_REPOSITORY=spraylee/tavily-mcp-multi-key
TAVILY_MCP_LATEST_PROBE_URL=...   # 覆盖"探测最新版本"的地址（默认 GitHub releases/latest）
```

### 直接运行本地缓存的二进制

如果已经手动下载或自行构建，可以直接把 MCP command 指向二进制：

```json
{
  "mcpServers": {
    "tavily": {
      "command": "/Users/your-name/.cache/spraylee/tavily-mcp-multi-key/v0.4.0/aarch64-apple-darwin/tavily-mcp-multi-key",
      "env": {
        "TAVILY_API_KEYS": "key1,key2"
      }
    }
  }
}
```

直接执行二进制是最纯的进程链：

```text
MCP host → tavily-mcp-multi-key (Rust)
```

### 单 key 兼容

```text
TAVILY_API_KEY=key1
```

`TAVILY_API_KEYS` 优先于 `TAVILY_API_KEY`。两个变量都没有时进入官方 keyless 模式；search 和 extract 是否可用由 Tavily 当前 keyless 政策决定。

## 自举下载行为

`scripts/bootstrap.sh` 支持：

1. 检测 macOS/Linux 以及 x64/arm64。
2. 版本解析：默认向 GitHub API 查询最新 Release tag（`TAVILY_MCP_VERSION` 非空则跳过查询、直接固定该版本）。
3. 按解析出的版本和 Rust target 拼出 GitHub Release asset URL。
4. 用 `curl` 下载压缩包和 `SHA256SUMS`，校验 SHA-256 后再解压。
5. 写入 `~/.cache/spraylee/tavily-mcp-multi-key/<version>/<target>/`（可由 `TAVILY_MCP_CACHE_DIR` 覆盖），记录 `last-version` 供离线启动回退。
6. 用目录锁避免多个 MCP 实例同时下载；新版本装好后清理旧版本目录。
7. 通过临时文件和原子 rename 安装二进制，并保存二进制 sidecar checksum。
8. 每次启动复核缓存文件；缓存被修改或发现新版本时重新下载。
9. 清理临时数据后 `exec` Rust 二进制，避免长期保留 shell 进程。

发布资产命名示例：

```text
tavily-mcp-multi-key-v0.4.0-aarch64-apple-darwin.tar.gz
tavily-mcp-multi-key-v0.4.0-x86_64-apple-darwin.tar.gz
tavily-mcp-multi-key-v0.4.0-x86_64-unknown-linux-gnu.tar.gz
SHA256SUMS
```

可选环境变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `TAVILY_MCP_VERSION` | 空（自动跟随最新） | 固定版本时设为 `vX.Y.Z` |
| `TAVILY_MCP_REPOSITORY` | `spraylee/tavily-mcp-multi-key` | GitHub `owner/repository` |
| `TAVILY_MCP_LATEST_PROBE_URL` | GitHub releases/latest 重定向 | 探测最新版本的地址（测试/镜像用）；不走 api.github.com，无配额限制 |
| `TAVILY_MCP_RELEASE_BASE_URL` | 对应 GitHub Release URL | 私有镜像或本地测试下载地址 |
| `TAVILY_MCP_CACHE_DIR` | `$XDG_CACHE_HOME` 或 `~/.cache` 下的缓存目录 | 本地二进制缓存位置 |
| `TAVILY_MCP_FORCE_DOWNLOAD` | `0` | 设为 `1` 强制重新下载 |
| `TAVILY_MCP_OFFLINE` | `0` | 设为 `1` 时只使用已有缓存 |

公开 Release 默认只允许 HTTPS 下载；`http://` 仅用于本地测试或显式配置的私有镜像。

## Key 轮换策略

服务启动时并行请求 Tavily `/usage`：

- 优先根据 `key.usage` 和 `key.limit` 跳过已耗尽的 Key；当 `key.limit` 为 `null` 时，使用 `account.plan_usage` 和 `account.plan_limit`。
- 按启动时得到的剩余 credits 从高到低建立优先级，优先使用额度更多的 Key。
- 不会在每次请求前刷新余额，也不会在多个 MCP 进程之间共享实时余额。
- `429` 进入短暂冷却，并尊重 `Retry-After`。
- `432/433` 标记为额度耗尽并切换到下一个 Key；重新探测后可自动复活。
- `401` 标记为无效。
- 如果预检因网络问题失败，Key 保持可用，由真实请求惰性识别。
- `/usage` 自身被限流时只影响观测面，不误封数据面正常的 Key。
- `research` 的创建、轮询和流式 fallback 始终使用同一个 Key。

Tavily 的额度单位是 credits，不是固定的搜索次数；Research 和高级搜索可能消耗更多 credits。

### 定期重排与自愈

- 每日 `TAVILY_REPROBE_HOUR`（默认 05:00，时区 `TAVILY_REPROBE_TZ`，默认 Asia/Shanghai）重排 key 优先级。
- 月初额度重置后，以 `/usage` 服务端结果自动复活 exhausted key。
- 全部 key 不可用且探测信息超过 10 分钟时，兜底补一次探测再放弃。

### 进程生命周期

宿主退出后 server 保证跟着退出：

1. stdin EOF / 传输关闭 → 立即退出。
2. SIGTERM / SIGINT / SIGHUP → 统一干净退出。
3. 孤儿自查：发现父进程变化即退出（`TAVILY_ORPHAN_CHECK_MS=0` 可禁用）。
4. 后台任务随服务 shutdown，不阻止进程退出。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `TAVILY_API_KEYS` | - | 多 key，逗号或换行分隔 |
| `TAVILY_API_KEY` | - | 单 key，兼容变量 |
| `TAVILY_API_BASE_URL` | `https://api.tavily.com` | API 地址，测试时可替换 |
| `TAVILY_REPROBE_HOUR` | `5` | 每日重排小时（0-23） |
| `TAVILY_REPROBE_TZ` | `Asia/Shanghai` | 重排时区 |
| `TAVILY_REPROBE_TICK_MS` | `60000` | 重排调度检查间隔 |
| `TAVILY_ORPHAN_CHECK_MS` | `60000` | 孤儿自查间隔（0=禁用） |
| `DEFAULT_PARAMETERS` | - | 搜索默认参数 JSON 覆盖 |
| `TAVILY_HUMAN_ID` | - | 请求头 `X-Human-Id` |

## 平台支持

GitHub Release 当前构建：

| 平台 | Rust target |
|---|---|
| Linux x64 | `x86_64-unknown-linux-gnu` |
| Linux arm64 | `aarch64-unknown-linux-gnu` |
| macOS arm64 | `aarch64-apple-darwin` |
| macOS x64 | `x86_64-apple-darwin` |
| Windows x64 | `x86_64-pc-windows-msvc` |

POSIX 平台使用 `scripts/bootstrap.sh`。Windows 可使用 `scripts/bootstrap.ps1`；PowerShell 会启动原生进程，但 Windows 没有 POSIX `exec` 语义。

## 从源码构建

需要 Rust stable、Cargo 和 Python 3（仅用于 E2E 测试）：

```bash
cargo build --release --locked
cargo test --locked
cargo fmt --all -- --check
python3 tests/e2e.py
python3 tests/bootstrap.py
./target/release/tavily-mcp-multi-key --list-tools
```

二进制入口是：

```text
src/main.rs
```

不需要进入 `rust/` 子目录；仓库根目录就是 Cargo crate 根目录。

## 发布

版本号在 `Cargo.toml` 中维护，GitHub Actions 会校验 tag 与 Cargo 版本一致：

```bash
# 例如 Cargo.toml version = "0.4.0"
git tag v0.4.0
git push origin v0.4.0
```

`.github/workflows/release.yml` 会：

1. 在 Linux、macOS、Windows 构建原生二进制。
2. 生成各平台 `.tar.gz` Release asset。
3. 生成统一的 `SHA256SUMS`。
4. 创建或更新 GitHub Release。

日常 push 和 PR 由 `.github/workflows/ci.yml` 执行格式检查、单测、构建和两套 E2E。

## 从 0.3.1 迁移

0.4.0 不再维护或发布 npm/TypeScript 版本，因此旧的：

```json
{ "command": "npx", "args": ["-y", "@spraylee/tavily-mcp-multi-key"] }
```

配置需要替换为上面的 **binox 运行**（推荐，见[官网](https://tavily-mcp.spraylee.com)三客户端配置）或 GitHub Release 自举配置。`TAVILY_API_KEY`、`TAVILY_API_KEYS` 和所有 MCP 工具调用方式保持不变。

## Docker

镜像同样不包含 Node/npm：

```bash
docker build -t tavily-mcp-multi-key .
docker run --rm -i \
  -e TAVILY_API_KEYS="key1,key2" \
  tavily-mcp-multi-key
```

## 认证说明

这是本地 stdio MCP fork，不实现 Tavily 远程 MCP 的 OAuth。API key 通过 MCP 客户端的 `env` 传给本地进程，不写入缓存、状态文件或日志。

## 许可证

MIT，见 [LICENCE](LICENCE)。
