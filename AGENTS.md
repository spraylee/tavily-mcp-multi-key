# Tavily MCP Multi-Key 项目上下文

## 项目目标

这是基于官方 `tavily-mcp@0.2.21` 的本地 stdio MCP fork。目标是保持官方的 5 个工具、输入 Schema、参数处理、返回格式和 `research` 行为，同时支持多个 Tavily API Key 自动轮换。

这是个人项目，GitHub 用户名和仓库地址使用 `spraylee`。

当前上游基线：

- 上游仓库：`https://github.com/tavily-ai/tavily-mcp.git`
- Git remote：`upstream`
- 基线提交：`259bfd205de90d74a131e9d2b29cb69ebe11feb7`

## 不可破坏的兼容约束

- 工具名必须保持 `tavily_search`、`tavily_extract`、`tavily_crawl`、`tavily_map`、`tavily_research`。
- 不要为了实现轮换而重写工具 Schema、默认参数、结果格式或 CLI 的 `--list-tools` 行为。
- 单 Key 的 `TAVILY_API_KEY` 必须继续可用；多 Key 使用逗号或换行分隔的 `TAVILY_API_KEYS`。
- Key 必须同时出现在 Tavily 请求的 `Authorization` header 和 JSON body 的 `api_key` 字段中。
- 不要通过修改 Axios 全局默认 header 切换 Key；请求级 header 是并发安全要求。
- `research` 从创建任务到轮询或流式完成必须绑定同一个 Key。轮询阶段的失败不得重新创建另一份 research 任务。
- 无 Key 时保留官方 keyless 模式。
- 本地 fork 不实现 Tavily 远程 MCP 的 OAuth；README 必须明确这一点。

## Key 状态策略

`src/key-pool.ts` 只保存当前 MCP 进程内的原始 Key、启动额度快照和不含凭证的状态信息，不做跨进程共享：

- 启动时并行请求 `/usage`，优先根据 `key.usage` 与 `key.limit` 判断；当 `key.limit` 为 `null` 时，使用 `account.plan_usage` 与 `account.plan_limit` 排除已耗尽 Key。
- 按启动时剩余 credits 降序建立优先级；当前最高优先级的可用 Key 持续承接请求。
- 不要在每次请求前刷新余额，不要引入共享余额文件、SQLite 或跨进程状态。
- `401` 标记为 `invalid`。
- `432/433` 标记为 `exhausted`，后续请求不再尝试。
- `429` 按 `Retry-After` 进入短暂 `cooldown`；没有该 header 时使用默认冷却时间。
- 预检失败但无法判断状态时保留 Key 为可用，让真实请求负责惰性识别。
- 状态不持久化，重启时重新预检；不要把原始 Key 写入状态文件、日志、测试或文档。

额度单位是 Tavily credits，不是固定的搜索次数。不同搜索深度、Extract/Crawl/Map 和 Research 的消耗不同，不要在本地假设每次调用只消耗 1 credit。

## 代码边界

- `src/index.ts`：尽量保留上游代码结构，只在认证、请求路由和启动预检处做必要修改。
- `src/key-pool.ts`：独立的轮换、冷却、耗尽和状态摘要逻辑，优先用纯单元测试覆盖。
- `test/`：使用本地 fake Tavily HTTP 服务和 MCP stdio 客户端，不调用真实 Tavily API。

## 当前实现状态

- 已完成 `TAVILY_API_KEYS` 解析、`/usage` 启动预检、轮询、429 冷却、432/433 耗尽、401 无效和 Research Key 绑定。
- 已覆盖启动跳过耗尽 Key、运行中失败切换、Research 流式 fallback、单 Key 兼容和 keyless 模式。
- 当前版本：`0.1.0`；npm 包已发布，尚未执行 `git push`。

## 版本与发布约定

- 使用 SemVer：修复用 `patch`，兼容功能用 `minor`，不兼容变更用 `major`。
- 默认使用 `pnpm version <patch|minor|major> --no-git-tag-version`，避免版本命令自动创建提交和 Tag；检查 diff 后再手动提交和打 Tag。
- 发布前必须执行 `pnpm build`、`pnpm test`、`pnpm pack --dry-run`。
- npm 包名为 `@spraylee/tavily-mcp-multi-key`，GitHub 个人身份使用 `spraylee`。
- 未经用户明确确认，不执行 `git push`、`pnpm publish` 或 `npm publish`。

## 常用命令

```bash
pnpm install
pnpm build
pnpm test
pnpm exec node build/index.js --list-tools
pnpm pack --dry-run
```

## 上游同步流程

1. `git fetch upstream`
2. 检查上游是否修改了 `src/index.ts` 的工具 Schema、请求参数或 Research 流程。
3. 合并上游变更后优先解决认证层冲突，不要覆盖 `KeyPool` 接入。
4. 执行 `pnpm build` 和 `pnpm test`。
5. 检查 `git diff`，确认没有凭证和无关格式化改动。

## 发布边界

当前只允许完成本地构建、测试和 npm 打包预检。未经用户明确确认，不执行 `git push`、`npm publish` 或其他上线操作。
