# @spraylee/tavily-mcp-multi-key

基于官方 `tavily-mcp` 的本地 stdio MCP Server，保持官方 5 个工具和功能，同时支持多个 Tavily API Key 的额度感知轮换。

## 支持的工具

- `tavily_search`
- `tavily_extract`
- `tavily_crawl`
- `tavily_map`
- `tavily_research`

工具名称、参数 Schema 和返回格式保持官方实现兼容。

## Key 轮换策略

服务启动时会并行请求 Tavily `/usage`：

- 优先根据 `key.usage` 和 `key.limit` 跳过已耗尽的 Key；当 `key.limit` 为 `null` 时，使用 `account.plan_usage` 和 `account.plan_limit`。
- 按启动时得到的剩余 credits 从高到低建立优先级，优先持续使用额度更多的 Key。
- 不会在每次请求前刷新余额，也不会在多个 MCP 进程之间共享实时余额。
- `429` 进入短暂冷却，并尊重 `Retry-After`。
- `432/433` 标记为额度耗尽并切换到下一个 Key，后续请求不再尝试。
- `401` 标记为无效。
- 如果预检因网络问题失败，Key 保持可用，由真实请求惰性识别。
- `research` 的创建、轮询和流式 fallback 始终使用同一个 Key。

Tavily 的额度单位是 credits，不是固定的搜索次数；Research 和高级搜索可能消耗更多 credits。

## 安装与使用

环境要求：Node.js 20+。

发布到 npm 后，推荐直接使用 `npx`，无需全局安装：

```bash
export TAVILY_API_KEYS="key-a,key-b,key-c"
npx -y @spraylee/tavily-mcp-multi-key@latest
```

为了避免自动获取未来版本，也可以固定版本：

```bash
npx -y @spraylee/tavily-mcp-multi-key@0.1.0
```

如需全局安装：

```bash
pnpm add --global @spraylee/tavily-mcp-multi-key@latest
tavily-mcp-multi-key
```

## 配置

多 Key 使用逗号或换行分隔：

```bash
export TAVILY_API_KEYS="key-a,key-b,key-c"
```

单 Key 旧配置继续支持：

```bash
export TAVILY_API_KEY="key-a"
npx -y @spraylee/tavily-mcp-multi-key@latest
```

如果同时配置两个变量，非空的 `TAVILY_API_KEYS` 优先。

官方的 `DEFAULT_PARAMETERS` 和 `TAVILY_HUMAN_ID` 环境变量继续支持。`TAVILY_API_BASE_URL` 仅用于测试或连接兼容 Tavily API 的代理，默认值为 `https://api.tavily.com`。

### Codex

命令行添加：

```bash
codex mcp add tavily \
  --env "TAVILY_API_KEYS=key-a,key-b,key-c" \
  -- npx -y @spraylee/tavily-mcp-multi-key@latest
```

也可以手动编辑 `~/.codex/config.toml`：

```toml
[mcp_servers.tavily]
command = "npx"
args = ["-y", "@spraylee/tavily-mcp-multi-key@latest"]

[mcp_servers.tavily.env]
TAVILY_API_KEYS = "key-a,key-b,key-c"
```

### Claude Code

命令行添加：

```bash
claude mcp add --scope user tavily \
  --env "TAVILY_API_KEYS=key-a,key-b,key-c" \
  -- npx -y @spraylee/tavily-mcp-multi-key@latest
```

也可以手动编辑用户级 `~/.claude.json`，或项目级 `.mcp.json`：

```json
{
  "mcpServers": {
    "tavily": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@spraylee/tavily-mcp-multi-key@latest"],
      "env": {
        "TAVILY_API_KEYS": "key-a,key-b,key-c"
      }
    }
  }
}
```

### Cursor / Claude Desktop

```json
{
  "mcpServers": {
    "tavily": {
      "command": "npx",
      "args": ["-y", "@spraylee/tavily-mcp-multi-key@latest"],
      "env": {
        "TAVILY_API_KEYS": "key-a,key-b,key-c"
      }
    }
  }
}
```

不要把真实凭证提交到 Git。可以复制 `.env.example` 到 `.env` 做本地测试；MCP 客户端配置中的环境变量不会写入本项目。

## 本地开发

环境要求：Node.js 20+、pnpm。

```bash
pnpm install
pnpm build
pnpm test
pnpm exec node build/index.js --list-tools
```

测试使用本地 fake Tavily HTTP 服务，不会调用真实 API，也不需要真实 Key。

查看 MCP Inspector：

```bash
pnpm inspector
```

打包预览：

```bash
pnpm pack --dry-run
```

本地源码临时接入 Codex，不需要先发布 npm：

```bash
cd /path/to/tavily-mcp-multi-key
pnpm build
export TAVILY_API_KEYS="key-a,key-b"
codex mcp add tavily-local \
  --env "TAVILY_API_KEYS=$TAVILY_API_KEYS" \
  -- node /path/to/tavily-mcp-multi-key/build/index.js
```

测试完成后移除临时配置：

```bash
codex mcp remove tavily-local
```

## 上游维护

本项目保留官方源码作为基线，官方仓库配置为 Git remote `upstream`：

```bash
git fetch upstream
git log --oneline upstream/main -5
```

同步后必须检查 `src/index.ts` 的工具 Schema、认证请求和 `research` 流程，并重新执行：

```bash
pnpm build
pnpm test
```

## 与远程 Tavily MCP 的区别

这是本地 stdio MCP，不包含 Tavily 远程 MCP 的 OAuth 登录流程。它适合 Codex、Cursor 等通过 `command` 启动 MCP 的场景；远程 URL、`mcp-remote` 和 OAuth 不参与本地 Key 轮换。

## 版本与发布

项目使用 SemVer：

- `patch`：修复问题，例：`0.1.0` → `0.1.1`。
- `minor`：增加向后兼容的功能，例：`0.1.0` → `0.2.0`。
- `major`：包含不兼容变更，例：`0.1.0` → `1.0.0`。

首次发布前登录 npm 并确认当前账号：

```bash
npm login
npm whoami
```

当前版本 `0.1.0` 可按以下流程首次发布：

```bash
pnpm build
pnpm test
pnpm pack --dry-run
pnpm publish --access public
```

后续发布新版本时，先升级版本号。`--no-git-tag-version` 不会自动创建 Git 提交和 Tag，便于检查 diff 后自行提交：

```bash
# 选择一个：patch、minor 或 major
pnpm version patch --no-git-tag-version
git diff -- package.json pnpm-lock.yaml
pnpm build
pnpm test
# 将示例版本替换为本次实际版本
git add package.json
git commit -m "release: v0.1.1"
git tag v0.1.1
pnpm publish --access public
```

发布后检查 npm 上的版本：

```bash
npm view @spraylee/tavily-mcp-multi-key version
npx -y @spraylee/tavily-mcp-multi-key@latest
```

如果同时维护 GitHub 个人仓库，可在首次推送前添加个人 remote：

```bash
git remote add origin git@github.com:spraylee/tavily-mcp-multi-key.git
git push -u origin main --follow-tags
```

官方上游仓库继续使用 `upstream`，个人 GitHub 仓库使用 `spraylee`。

如需发布测试版本，可使用 npm dist-tag：

```bash
pnpm publish --access public --tag next
```

不要把 API Key 写入 Git、npm 包或发布命令的可公开日志。`pnpm pack --dry-run` 可确认最终包只包含 `build`、README、许可证和包配置。

## 发布前检查

```bash
pnpm build
pnpm test
pnpm pack --dry-run
git diff --check
```

在用户确认前，不执行 `git push` 或 `npm publish`。
