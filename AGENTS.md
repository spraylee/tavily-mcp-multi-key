# AGENTS.md - Tavily MCP Multi-Key

## 项目目标

这是一个基于官方 Tavily MCP 的本地 stdio MCP fork。项目使用纯 Rust 实现，支持多个 Tavily API Key 的额度感知轮换，并保持官方工具、输入 Schema、参数处理、返回格式和 Research 行为兼容。

GitHub 仓库：`https://github.com/spraylee/tavily-mcp-multi-key`

## 不可破坏的兼容约束

- 工具名必须保持 `tavily_search`、`tavily_extract`、`tavily_crawl`、`tavily_map`、`tavily_research`。
- `tavily_key_status` 是本 fork 的额外工具。
- 不要为了实现轮换而改变工具 Schema、默认参数、结果格式或 `--list-tools` 行为。
- 单 Key 的 `TAVILY_API_KEY` 必须继续可用；多 Key 使用逗号或换行分隔的 `TAVILY_API_KEYS`。
- Key 必须同时出现在 Tavily 请求的 Authorization header 和 JSON body 的 `api_key` 字段中。
- 请求级 header 是并发安全要求，不要用全局 header 切换 Key。
- `research` 从创建任务到轮询或流式完成必须绑定同一个 Key。
- 无 Key 时保留官方 keyless 模式。
- 本地 fork 不实现 Tavily 远程 MCP OAuth；README 必须明确这一点。

## 目录边界

- `src/main.rs`：MCP stdio 入口、生命周期和后台任务。
- `src/key_pool.rs`：Key 轮换、冷却、耗尽、探测和状态摘要。
- `src/tavily.rs`：Tavily HTTP 请求、Usage 探测和 Research 流程。
- `src/tools.rs`：工具 Schema、dispatch 和输出格式化。
- `scripts/bootstrap.sh`：macOS/Linux GitHub Release 自举下载器，最终 exec 原生二进制。
- `scripts/bootstrap.ps1`：Windows PowerShell 自举下载器。
- `tests/e2e.py`：fake Tavily API + Rust MCP server E2E。
- `tests/bootstrap.py`：本地 Release fixture + 下载、校验、缓存、exec E2E。
- `.github/workflows/ci.yml`：格式、单测、构建和 E2E。
- `.github/workflows/release.yml`：多平台构建、打包、checksum 和 GitHub Release。

仓库根目录就是 Cargo crate 根目录；不要重新引入 `rust/` 子目录、TypeScript 源码或 npm runtime launcher。

## Key 状态策略

Key 状态只存在当前 MCP 进程内，不做跨进程共享：

- 启动时并行请求 `/usage`，优先根据 `key.usage` 与 `key.limit` 判断；`key.limit` 为 `null` 时使用 account fallback。
- 按启动时剩余 credits 降序建立优先级。
- 不在每次请求前刷新余额，不引入共享余额文件、SQLite 或跨进程状态。
- `401` 标记为 `invalid`。
- `432/433` 标记为 `exhausted`。
- `429` 按 Retry-After 进入短暂 cooldown。
- 无法判断的预检网络失败保留 Key 为可用，让真实请求惰性识别。
- 原始 Key 不得写入状态文件、日志、测试 fixture 或文档。

额度单位是 Tavily credits，不要假设每次调用固定消耗 1 credit。

## 开发与验证

```bash
cargo fmt --all -- --check
cargo test --locked
cargo build --release --locked
python3 tests/e2e.py
python3 tests/bootstrap.py
./target/release/tavily-mcp-multi-key --list-tools
```

修改 Rust 行为时先增加能失败的测试，再实现最小修复；fake API 测试不得调用真实 Tavily API。

## 发布约定

- 使用 SemVer，版本号唯一来源是 `Cargo.toml`。
- GitHub Release tag 必须与 Cargo 版本一致，例如 `version = "0.4.0"` 对应 `v0.4.0`。
- Release 资产必须包含 macOS/Linux/Windows 目标二进制和 `SHA256SUMS`。
- 公共下载默认固定版本并通过 HTTPS；不要把生产文档写成不受控的 `latest`。
- 自举脚本必须下载到文件而不是直接 `curl | sh` 接 MCP stdin；最终必须 `exec` 原生二进制。
- 未经用户明确确认，不执行 `git push`、创建 Release 或其他上线操作。
