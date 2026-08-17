# OpenCode2 zh-CN

> [!IMPORTANT]
> 本仓库是基于 [anomalyco/opencode](https://github.com/anomalyco/opencode) V2 的独立社区二开，
> 与 anomalyco、OpenCode 官方项目及其维护团队没有隶属、授权或背书关系。
> 上游项目与原作者的版权和 MIT License 归属保持不变。

**English summary:** OpenCode2 zh-CN is an independent, community-maintained fork of
OpenCode V2. It focuses on a Simplified Chinese TUI, native OpenAI Responses support,
durable session execution, provider-managed compaction safeguards, migration tooling,
and reproducible Windows builds. It is not affiliated with or endorsed by the upstream
OpenCode project. The initial public publication contains source code only.

## 当前状态

- 发布形态：源码公开，暂不提供 GitHub Release 或预编译二进制。
- 主要平台：当前自定义构建和运行验证集中在 Windows x64。
- 上游策略：按定制保护清单逐项审查、选择性移植，不把本仓库当作无差异镜像。
- GitHub Actions：首次公开时默认禁用，待 fork 专属工作流和密钥边界完成独立审计后再决定是否启用。
- 稳定性：基于仍在快速演进的 OpenCode V2，适合能够自行构建、验证和排障的用户。

## 主要增强

| 领域 | 本分支的实现 |
| --- | --- |
| 简体中文体验 | 简体中文 TUI、本地化文案和针对中文终端交互的定制。 |
| OpenAI Responses | 原生 Responses 协议路由、流式事件、工具调用、provider checkpoint 与 opaque encrypted content 持久化。 |
| 远程压缩 | 正常请求携带由模型限制和 buffer 动态计算的 `compact_threshold`；支持自动 checkpoint 与手动 `/compact`。 |
| 压缩保护 | 成功响应的上下文用量超过动态阈值 5%，且没有已完成的自动 checkpoint 时，同一次 execution run 最多补发一次 `compaction_trigger`；触发仍失败则停止，避免继续冲向模型上限。 |
| Session 执行 | SQLite 跨进程 lease、owner fencing、heartbeat、崩溃恢复和 restart continuity，防止多个进程重复接管同一 Session。 |
| 上下文治理 | 受保护规则上下文、工具结果裁剪、远程 checkpoint replay、子代理 continuation 与历史投影保护。 |
| V1 迁移 | V1 到 V2 的上下文迁移、只读预演、备份和验收工具。 |
| Windows 构建 | 固定 Bun canary 编译运行时、SHA-256 校验、构建 sidecar、service smoke 和不覆盖运行中二进制的发布流程。 |
| CPU 运行档位 | CLI、server、service 和 self-spawn 链路中的 CPU profile 传播。 |

远程压缩阈值不是固定的 `304000`。该数值只是特定模型配置下的计算结果；实际阈值由模型的
input/context/output limit 与用户配置的 compaction buffer 共同决定。第三方网关必须真正实现
OpenAI Responses 的 `context_management` 和 `compaction_trigger` 语义，不能只接受字段而忽略它们。

完整定制边界和上游同步保护规则见 [CUSTOMIZATIONS.md](CUSTOMIZATIONS.md) 与
[upstream-sync-preservation.md](specs/v2/upstream-sync-preservation.md)。

## 上游关系与同步记录

本分支的 V2 定制基点是上游提交
[`b0480a6f`](https://github.com/anomalyco/opencode/commit/b0480a6f9350d1846cca12a4fd282bdf2286e603)。
之后的上游变化不是整段 merge，而是依据定制保护矩阵选择性审查和移植。

截至 **2026-08-17**：

- 最近完成的选择性同步记录审查到上游 head
  [`7731d123`](https://github.com/anomalyco/opencode/commit/7731d1235dec02a2f0fc8977e7140bf0d446fa9f)。
- 后续上游 head
  [`6106cb64`](https://github.com/anomalyco/opencode/commit/6106cb64c7e28e7b379638b75d521fcb13acb392)
  已进入差异评估，但不属于当前已合入范围。

“审查到某个 head”不表示该范围内所有提交都被合入。每次同步的选择、排除、验证和残余风险记录在
[`specs/v2/upstream-sync-records/`](specs/v2/upstream-sync-records/) 中。

## 从源码运行

### 前置条件

- Git
- [Bun 1.3.14](https://bun.sh/)，与根目录 `packageManager` 固定版本一致
- Windows 构建脚本需要 PowerShell 7 (`pwsh`)

```powershell
git clone https://github.com/521ox/opencode2-zh-CN.git
Set-Location opencode2-zh-CN
bun install
bun dev
```

模型、provider 和网关凭据应通过你自己的 OpenCode 配置或环境变量提供。不要把 API key、会话数据库、
日志或本机配置提交到仓库，也不要在公开 Issue 中粘贴这些内容。

## Windows x64 可复现构建

本仓库使用固定脚本 [build-custom-windows.ps1](script/build-custom-windows.ps1)。构建采用两个明确分工的
Bun 运行时：

1. **Build Bun 1.3.14**：执行安装、测试编排和构建脚本。
2. **Pinned compile runtime**：默认使用经过 asset、archive 与 executable SHA-256 校验的
   `1.4.0-canary.1+aec33f581` 执行 `bun build --compile`。

脚本默认不会替换正在运行的安装文件。建议始终显式指定发布目录：

```powershell
$publish = Join-Path $PWD "dist\windows-x64"

pwsh -File .\script\build-custom-windows.ps1 `
  -BuildBun "$env:USERPROFILE\.bun\bin\bun.exe" `
  -PublishDirectory $publish `
  -RunServiceSmoke
```

构建产物包含候选 executable 和 `.build.json` 身份 sidecar。只有脚本退出成功、sidecar 与 executable
SHA-256 对应且 service smoke 通过后，候选文件才应被视为可使用产物。不要在构建时覆盖当前正在运行的
OpenCode2 executable。

固定 runtime、缓存校验和回退模式的完整约束见
[bun-canary-snapshot.md](specs/v2/bun-canary-snapshot.md)。

## 验证

根目录 `bun test` 被设计为直接失败，防止把所有 package 的测试无边界地混在一起运行。请使用类型检查和
定向测试：

```powershell
bun run typecheck
bun test packages/core/test/session-compaction.test.ts
bun test packages/core/test/session-execution.test.ts
bun test packages/core/test/session-runner.test.ts
bun test packages/ai/test/provider/openai-responses.test.ts
```

具体改动还应运行对应 package 的测试、lint、migration check 和 `git diff --check`。公开源码不等于某个
本地构建已经通过这些检查；以提交记录或维护者提供的验证证据为准。

## 已知限制

- 初始公开仓库不提供预编译二进制，也不承诺自动更新。
- 某些第三方 OpenAI-compatible/DeepSeek 网关会发送 `response.reasoning_text.delta`；当前 AI SDK
  compatibility 路径尚未显示该事件。根因已经定位，但本分支尚未确定兼容策略。
- 第三方网关可能接受 `compact_threshold` 却不执行远程自动压缩。当前 one-shot fallback 能阻止上下文
  无限增长，但不能让不支持 compaction 的网关获得官方能力。
- OpenCode2 会按用户授权调用 shell、文件系统、网络、MCP 和其他本机工具。它不是安全沙箱。
- 上游 V2 变化较快；同步时必须保留本分支的 Session、Responses、迁移和构建不变量。

## 安全与问题反馈

- fork 特有缺陷和功能请求：[GitHub Issues](https://github.com/521ox/opencode2-zh-CN/issues)
- fork 的非公开安全报告：[GitHub Security Advisories](https://github.com/521ox/opencode2-zh-CN/security/advisories/new)
- 可确认也影响上游的安全问题：同时按照
  [上游 SECURITY.md](https://github.com/anomalyco/opencode/blob/v2/SECURITY.md) 私下报告

报告前请删除 API key、Cookie、Authorization header、会话内容、数据库、日志中的私有路径和任何客户数据。
更多说明见 [SECURITY.md](SECURITY.md)。

## 贡献

贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。较大改动应先说明目标、行为边界、验证方法以及对
上游同步保护矩阵的影响。

## 许可与归属

本项目延续上游的 [MIT License](LICENSE)。原始 OpenCode 项目、其作者与贡献者保留各自版权；本分支的
额外改动由相应提交作者贡献。详细说明见 [NOTICE.md](NOTICE.md)。
