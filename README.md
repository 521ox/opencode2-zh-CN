# OpenCode2 zh-CN

> [!IMPORTANT]
> 本仓库是基于 [anomalyco/opencode](https://github.com/anomalyco/opencode) V2 的独立社区二开，
> 与 anomalyco、OpenCode 官方项目或其维护团队没有隶属、授权、赞助或背书关系。
> 上游项目、作者和贡献者的版权及 MIT License 归属保持不变。

**English summary:** OpenCode2 zh-CN is an independent, community-maintained
OpenCode V2 fork. It provides a Simplified Chinese-first TUI, explicit native
provider routes, bounded remote-compaction behavior, session and subagent
enhancements, plugin management, and additional local tools. It is not
affiliated with or endorsed by anomalyco or the upstream OpenCode project. The
public repository is a source-only sanitized snapshot: it provides no GitHub
Release or prebuilt binary, and GitHub Actions are disabled.

## 当前状态

- **发布形态**：周期性发布经过清理的源码快照提交；不提供 GitHub Release 或预编译二进制。
- **自动化**：GitHub Actions 当前禁用。不要把公开源码等同于已由托管 CI 验证的构建。
- **运行时前置**：以根目录 `packageManager` 为准，当前为 **Bun 1.3.14**。
- **上游同步**：已选择性审查到上游提交
  [`0808ebc3`](https://github.com/anomalyco/opencode/commit/0808ebc3c52286f5a3a602f82f069ae597f86469)。
  该提交不是本 fork 的直接祖先；“审查到”也不表示该范围内的每项上游改动都已合入。
- **适用人群**：当前快照适合能够自行审阅源码、构建、执行 package 范围测试并管理本机权限的用户。

## 主要功能

- 简体中文优先的 TUI 与非交互命令界面；英文仍作为可选语言和字典回退。
- 原生 OpenAI Responses、独立的兼容 Responses/Chat 路由，以及 official xAI Responses 路由。
- provider checkpoint 的持久化与重放、受控自动/手动 compaction、跨进程 Session lease。
- direct-child subagent continuation、完整子代理最终结论、command subagents 与 background Job。
- fork-owned 普通工具 `environment_tools` 与 `direct_exec`。
- 仅 Code Mode 可见且 pinned 的 `opencode.session_move`。
- Plugin CLI/TUI 管理界面；`/stats` 与 CLI `stats`；根命令 `update` 作为 `upgrade` 的别名。
- App/WebUI 的 **Copy Session ID** 命令。该功能不是 TUI 命令；TUI 通过自己的 Session/子代理界面显示相关 ID。
- Windows 上 persistent terminal panes 默认关闭；用户显式启用前应先确认所需 PTY 支持可用。

`environment_tools` 是环境范围的程序目录，而不是已安装软件扫描器；目录中没有某个名称，不能证明程序未安装。
`direct_exec` 只接受有效 catalog ID 与 argv，不能接受原始 executable 路径、shell 命令串、调用方环境变量、stdin、
shell 语法或后台执行。catalog membership 也不等于执行授权。

`opencode.session_move` 只允许移动当前 Session，或当前 Session 所拥有的 direct child；不能移动任意、外部或更深层
Session。移动在安全边界生效，因此同一次调用中不要继续执行依赖目标目录的操作。

内部 ACP 与诊断接口不是日常用户界面，本 README 不把它们作为普通功能入口。

## Provider / protocol / operation 完整白名单

能力由**配置的 package、所选 protocol 以及该 route 实际拥有的 operation**共同决定。provider 显示名称、
provider ID 或 `baseURL` 相似都不能授予能力。

| 配置 package / route | 协议与 storage | Compaction | Responses WebSocket |
| --- | --- | --- | --- |
| `@opencode-ai/ai/providers/openai` | 完整 native OpenAI Responses；允许显式 native `store` | 自动与手动 remote compaction | 可选，默认关闭 |
| `@opencode-ai/ai/providers/openai/responses` | 上一项的同一 native owner 别名 | 与 native parent 相同 | 与 native parent 相同 |
| `@opencode-ai/ai/providers/openai-compatible/responses` | generic Responses-compatible HTTP；最终 dispatch 强制 `store: false` | 仅 local summary；移除 native compaction 字段 | 不支持 |
| `aisdk:@ai-sdk/openai` | 映射到 generic compatible Responses，不加载 AI SDK OpenAI provider | 仅 local summary | 不支持 |
| `@opencode-ai/ai/providers/openai-compatible` | generic OpenAI-compatible Chat Completions | 仅 local summary | 非 Responses route |
| `@opencode-ai/ai/providers/xai` 的 Responses route | official xAI Responses；强制 `store: false` | route-owned `POST /responses/compact` | 不因 WebSocket 获得 compact operation |
| `@opencode-ai/ai/providers/xai` 的 Chat route | xAI Chat Completions | 仅 local summary | 非 Responses route |

DeepSeek、Anthropic、Azure、Modal、Copilot、generic compatible Responses、Chat 及其他未在上表明确授予 remote
compaction operation 的 route 均使用 local summary。不能通过改 provider 名称或 `baseURL` 把它们提升为 native
OpenAI 或 official xAI 能力。

## Compaction 配置与线路语义

当前 V2 顶层配置只有以下字段：

```jsonc
{
  "compaction": {
    "auto": true,        // 默认 true
    "prune": false,      // 默认 false；只裁剪请求投影，不改 durable history
    "buffer": 20000,     // 默认 20000
    "keep": {
      "tokens": 15000    // 默认 15000；只用于 local-summary tail
    }
  }
}
```

不存在顶层 `compact_threshold`。remote threshold 由运行时根据已解析模型限制计算：

```text
min(inputLimit - buffer,
    contextLimit - max(min(outputLimit, 32000), buffer))
```

缺少 `inputLimit` 时按无穷大处理；最终结果必须是正 safe integer，否则不触发 remote compaction。自定义模型应填写
准确的 `limit.context`、`limit.input`（若提供方有独立输入上限）和 `limit.output`；错误的限制会产生错误阈值。

### Native OpenAI Responses

只有 `@opencode-ai/ai/providers/openai`（及其 `/openai/responses` 别名）拥有 native remote compaction：

- 普通 `POST /responses` 通过 `context_management` 携带计算后的 `compact_threshold`；这不是
  `/responses/compact` 调用。
- 用户手动 `/compact`，以及一次性的 overflow/缺失 checkpoint 恢复，仍走普通 `/responses`，并把
  `{ "type": "compaction_trigger" }` 作为最终 input item。
- native OpenAI 生产路径绝不调用 `/responses/compact`。remote trigger 失败会显式停止 Session，不会静默回退到
  local summary。

自定义 OpenAI gateway 必须真实实现 `context_management`、opaque checkpoint 和 `compaction_trigger` 语义；仅接受并
忽略字段不代表兼容。

### Official xAI Responses

只有 package `@opencode-ai/ai/providers/xai` 所选的 dedicated Responses route 拥有 xAI compact operation：

- crossing threshold 或手动 `/compact` 都恰好调用一次所选 `<baseURL>/responses/compact`。
- proxy 或 gateway 必须实现该 endpoint，并返回一个可重放的 opaque `encrypted_content` compaction item。
- 404、错误响应或缺失 compaction item 都是可见失败；不会 local fallback，也没有 custom-base-URL opt-out。

两个独立、安全编写的配置示例见 [opencode.example.jsonc](opencode.example.jsonc)。它不是从任何 live config 删字段
生成的，所有 credential 与 gateway URL 均使用环境变量占位符。

## Session memory 插件与隐私

`session-memory-v2` 的仓库内位置为 [`plugins/session-memory/`](plugins/session-memory/)。请按该目录 README 的
repository-relative 步骤安装或启用，并在使用前自行审阅插件权限与当前快照中的验证说明；本页不把“源码已放入目录”
等同于对任意环境的通过或安全承诺。

插件生成的 snapshot 即使已经 redacted，仍可能包含提示词、工具结果、文件名、项目结构或其他敏感上下文。请将生成
snapshot 保留在本机受控位置，使用最小文件权限，并且**不要提交到 Git、Issue、PR 或聊天记录**。共享前必须再次人工
审阅。

## 从源码运行

前置条件：Git、[Bun](https://bun.sh/) 1.3.14，以及目标平台所需的本机构建依赖。

```bash
git clone https://github.com/521ox/opencode2-zh-CN.git
cd opencode2-zh-CN
bun install
bun dev
```

不要把 API key、Cookie、Session 数据库、日志、本机配置、生成的 memory snapshot 或私有 endpoint 提交到仓库。

## 验证

根目录的聚合测试入口被故意阻止，以免把不同 package 的测试无边界混合运行。请通过 Bun 的 global `--cwd`
选项从相关 package cwd 执行类型检查和定向测试，例如：

```bash
bun --cwd packages/schema run typecheck
bun --cwd packages/schema test test/compaction-contract.test.ts
bun --cwd packages/core run typecheck
bun --cwd packages/core test test/config/compaction.test.ts
bun --cwd packages/ai run typecheck
bun --cwd packages/ai test test/provider/compaction.test.ts
```

具体修改还应运行其 owner package 的相关测试、lint/format 检查以及 `git diff --check`。由于 Actions 禁用，公开
snapshot 本身不构成这些检查已经通过的证明。

## 安全、贡献与许可

- fork 特有缺陷与功能请求：[GitHub Issues](https://github.com/521ox/opencode2-zh-CN/issues)
- fork 的私密漏洞报告：[GitHub Security Advisories](https://github.com/521ox/opencode2-zh-CN/security/advisories/new)
- 同时影响上游的问题：按上游 [SECURITY.md](https://github.com/anomalyco/opencode/blob/v2/SECURITY.md) 私密报告
- 贡献规则：[CONTRIBUTING.md](CONTRIBUTING.md)
- 定制边界：[CUSTOMIZATIONS.md](CUSTOMIZATIONS.md)
- 归属说明：[NOTICE.md](NOTICE.md)
- 许可：[MIT License](LICENSE)

OpenCode2 可以在用户授权下读写文件、执行进程并访问网络；它不是安全沙箱。使用最小操作系统权限，审阅 provider、
MCP、plugin 和工具权限，并在允许写操作前备份重要工作。
