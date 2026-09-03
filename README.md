# @spraylee/tavily-mcp-multi-key

基于官方 `tavily-mcp` 的本地 stdio MCP Server，保持官方 5 个工具和功能，同时支持多个 Tavily API Key 的额度感知轮换。

> **v0.3.0 起为 Rust 实现**：npm 包内含预编译二进制（linux/darwin/win32 × x64/arm64），`npx` 用法完全不变。相比旧 Node 版：冷启动 1446ms→5ms，常驻内存 208MB→7.5MB。工具 Schema 与 TS 版字节级对齐（parity 测试保证），TS 源码保留在本仓库 `src/` 供对照。

## 支持的工具

- `tavily_search`
- `tavily_extract`
- `tavily_crawl`
- `tavily_map`
- `tavily_research`
- `tavily_key_status`（多 key 版新增：查看 key 池状态/余额，`refresh=true` 强制重探测）

工具名称、参数 Schema 和返回格式保持官方实现兼容。

## 安装与使用

```bash
# 直接跑（推荐）
TAVILY_API_KEYS="key1,key2" npx -y @spraylee/tavily-mcp-multi-key

# 单 key 兼容
TAVILY_API_KEY="key1" npx -y @spraylee/tavily-mcp-multi-key
```

MCP 客户端配置示例（stdio）：

```json
{
  "mcpServers": {
    "tavily": {
      "command": "npx",
      "args": ["-y", "@spraylee/tavily-mcp-multi-key@latest"],
      "env": {
        "TAVILY_API_KEYS": "key1,key2"
      }
    }
  }
}
```

无 Key 时自动进入 keyless 模式（search/extract 可用，额度由 Tavily keyless 政策决定）。

## Key 轮换策略

服务启动时会并行请求 Tavily `/usage`：

- 优先根据 `key.usage` 和 `key.limit` 跳过已耗尽的 Key；当 `key.limit` 为 `null` 时，使用 `account.plan_usage` 和 `account.plan_limit`。
- 按启动时得到的剩余 credits 从高到低建立优先级，优先持续使用额度更多的 Key。
- 不会在每次请求前刷新余额，也不会在多个 MCP 进程之间共享实时余额。
- `429` 进入短暂冷却，并尊重 `Retry-After`。
- `432/433` 标记为额度耗尽并切换到下一个 Key，后续请求不再尝试；额度按自然月重置（每月 1 号），重新探测后会自动复活。
- `401` 标记为无效。
- 如果预检因网络问题失败，Key 保持可用，由真实请求惰性识别。
- `/usage` 端点自身被限流（429）时只影响观测面，不会误封数据面正常的 Key。
- `research` 的创建、轮询和流式 fallback 始终使用同一个 Key。

Tavily 的额度单位是 credits，不是固定的搜索次数；Research 和高级搜索可能消耗更多 credits。

### 定期重排与自愈

- 每日 `TAVILY_REPROBE_HOUR`（默认 05:00，时区 `TAVILY_REPROBE_TZ`，默认 Asia/Shanghai）重排 key 优先级
- 月初额度重置后自动复活 exhausted key（以 `/usage` 服务端真相为准）
- 全部 key 不可用且探测信息超过 10 分钟时，兜底补一次探测再放弃

### 进程生命周期（issue #2）

宿主退出后 server 保证跟着退出，四层防护：

1. stdin EOF / 传输关闭 → 立即退出
2. SIGTERM / SIGINT / SIGHUP → 统一干净退出
3. 孤儿自查：启动时快照父进程 PID，发现变化（re-parent）即退出（`TAVILY_ORPHAN_CHECK_MS=0` 可禁用，默认 60s 一次）
4. 后台任务（每日重排等）不阻止进程退出

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `TAVILY_API_KEYS` | - | 多 key，逗号或换行分隔 |
| `TAVILY_API_KEY` | - | 单 key（`TAVILY_API_KEYS` 优先） |
| `TAVILY_API_BASE_URL` | `https://api.tavily.com` | API 地址（测试用） |
| `TAVILY_REPROBE_HOUR` | `5` | 每日重排小时（0-23） |
| `TAVILY_REPROBE_TZ` | `Asia/Shanghai` | 重排时区 |
| `TAVILY_REPROBE_TICK_MS` | `60000` | 重排调度检查间隔 |
| `TAVILY_ORPHAN_CHECK_MS` | `60000` | 孤儿自查间隔（0=禁用） |
| `DEFAULT_PARAMETERS` | - | 搜索默认参数 JSON 覆盖 |
| `TAVILY_HUMAN_ID` | - | 请求头 X-Human-Id |

## 平台支持

npm 包内置预编译二进制：

| 平台 | 目录 |
|---|---|
| Linux x64 / arm64 | `bin/linux-x64` `bin/linux-arm64` |
| macOS arm64 / x64 | `bin/darwin-arm64` `bin/darwin-x64` |
| Windows x64 | `bin/win32-x64` |

`npx` / `npm i` 后由 `npm/launcher.js` 自动选择对应二进制执行。没有覆盖的平台会给出明确报错和 issue 链接；也可自行编译：`cd rust && cargo build --release`。

## 从源码构建（Rust）

```bash
cd rust
cargo build --release
cargo test                       # 24 个单元测试
python3 tests/e2e.py             # 6 场景 E2E（需 python3，起本地 fake API）
./target/release/tavily-mcp-multi-key --list-tools
```

## 版本历史

- **0.3.0** — Rust 重写：预编译二进制分发；启动 274x、内存 -96%；schema 与 TS 字节级对齐；生命周期防护完整移植
- 0.2.2 — 修复宿主退出后孤儿进程堆积（issue #2，四层防护）
- 0.2.1 — 修复 `/usage` 观测面 429 误判；每日重排 + 月度自愈
- 0.2.0 — 首个多 key 版本：启动排序、故障转移、`tavily_key_status`
