# OpenCode2 zh-CN

**一个面向中文与 Windows 用户的 OpenCode V2 独立社区二开：把 provider 能力边界、长 Session 恢复、本地工具执行和公开下载做得更清楚、更可控。**

它不只是翻译。这个 fork 处理的是实际使用中的一组问题：中文界面不完整、相似 provider 被误当成同一种协议、长任务中断后难以接续、子代理结论不完整、本地程序调用边界含糊，以及公开二进制难以核对来源。

> [!IMPORTANT]
> 本项目与 anomalyco、OpenCode 上游维护者及 OpenAI 均无隶属、授权、赞助或背书关系。它保留上游版权与 MIT License，是独立维护的社区 fork。

**快速入口：** [下载当前预发行版](https://github.com/521ox/opencode2-zh-CN/releases/tag/v1.18.4-zhcn.2) · [选择 provider 路线](docs/provider-compaction.md) · [恢复 Session](docs/session-history.md) · [Agent 接手](docs/agent-takeover.md) · [定制边界](CUSTOMIZATIONS.md) · [安全报告](SECURITY.md)

## 目录

- [为什么有这个 fork](#为什么有这个-fork)
- [适合谁](#适合谁)
- [下载与 Windows 三步开始](#下载与-windows-三步开始)
- [30 秒能力地图](#30-秒能力地图)
- [核心能力：问题、改变、结果与边界](#核心能力问题改变结果与边界)
- [Provider 与 compaction 快速开始](#provider-与-compaction-快速开始)
- [Session 备份、恢复与历史分析](#session-备份恢复与历史分析)
- [长任务、子代理、MCP 与规则目录](#长任务子代理mcp-与规则目录)
- [本地工具快速开始](#本地工具快速开始)
- [可靠性与资源管理](#可靠性与资源管理)
- [完整功能矩阵](#完整功能矩阵)
- [GPT-5.6 开发来源与 Agent 接手](#gpt-56-开发来源与-agent-接手)
- [发布、校验与更新](#发布校验与更新)
- [从源码运行与贡献](#从源码运行与贡献)
- [安全、隐私、上游与许可](#安全隐私上游与许可)
- [社区与友链](#社区与友链)
- [English summary](#english-summary)

## 为什么有这个 fork

上游 OpenCode V2 提供了强大的编码代理基础，但“能接入一个模型”不等于“这个连接真实拥有所有能力”，一次命令退出也不一定意味着它的输出管道已经正确收尾。对于中文、Windows、长 Session 和多代理用户，这些差异会直接变成误配置、等待不结束、上下文丢失或更新来源混淆。

OpenCode2 zh-CN 因此选择了一条明确路线：

1. **先把日常体验讲人话。** 普通 TUI 与命令界面简体中文优先，入口和失败尽量可见。
2. **按真实 route 授权能力。** 原生 OpenAI Responses、兼容 Responses、兼容 Chat 与 xAI Responses 不互相冒充。
3. **让长工作可接续。** Session、checkpoint、直接子代理与跨进程执行所有权都有明确边界。
4. **让本机执行可解释。** 发现/记忆外部程序和实际执行是两个步骤、两种权限。
5. **让公开产物可核对。** 当前预发行版提供六个原生 CLI 压缩包及哈希、manifest 和 sidecar，而不是让用户猜一个二进制来自哪里。

## 适合谁

- **第一次使用 OpenCode 的中文用户**：希望先下载、核对、运行，再逐步了解配置。
- **Windows 用户**：需要原生 CLI、PowerShell 校验步骤，以及明确的未签名提示。
- **使用 OpenAI、兼容网关或 xAI 的用户**：不希望相似 URL 或 provider 名称带来错误能力假设。
- **运行长 Session 或多代理任务的人**：需要可恢复历史、直接子代理续跑和清楚的工作所有权。
- **维护自定义 fork 的开发者**：需要知道哪些行为是二开自研、可靠性加固或选择并适配上游。

如果你需要官方支持、签名安装器、稳定版承诺、自动 fork 更新，或无需审阅即可运行任意插件/工具，本项目目前不满足这些要求。

## 下载与 Windows 三步开始

当前公开二进制版本是 **[`v1.18.4-zhcn.2`](https://github.com/521ox/opencode2-zh-CN/releases/tag/v1.18.4-zhcn.2)**：一个预发行版，包含 Windows x64/arm64、Linux glibc x64/arm64、macOS x64/arm64 共六个原生 CLI archive，均使用 **Bun 1.4.2**、启用 bytecode 并内嵌完整 WebUI。六个平台的原生构建、版本/运行时检查及隔离服务 smoke 均已通过；这不是广泛稳定性保证。

### 1. 下载与你机器匹配的 archive

从上述 fork Release 页面下载对应平台文件，同时下载 `SHA256SUMS`。不要从上游更新服务、第三方网盘或不明镜像替代。

| 系统 | Release 资产 | 解压后的 CLI |
| --- | --- | --- |
| Windows x64（多数 Intel/AMD 电脑） | `opencode2-windows-x64.zip` | `cli-windows-x64/bin/opencode2.exe` |
| Windows ARM64 | `opencode2-windows-arm64.zip` | `cli-windows-arm64/bin/opencode2.exe` |
| Linux glibc x64 | `opencode2-linux-x64.tar.gz` | `cli-linux-x64/bin/opencode2` |
| Linux glibc ARM64 | `opencode2-linux-arm64.tar.gz` | `cli-linux-arm64/bin/opencode2` |
| macOS Intel | `opencode2-darwin-x64.tar.gz` | `cli-darwin-x64/bin/opencode2` |
| macOS Apple Silicon | `opencode2-darwin-arm64.tar.gz` | `cli-darwin-arm64/bin/opencode2` |

### 2. 在 PowerShell 核对 SHA-256

```powershell
Set-Location "$HOME\Downloads"
$archive = Get-Item ".\opencode2-windows-x64.zip"
Get-FileHash $archive.FullName -Algorithm SHA256
Select-String -Path ".\SHA256SUMS" -SimpleMatch $archive.Name
```

ARM64 用户把文件名换成 `opencode2-windows-arm64.zip`。确认两处 SHA-256 完全一致后再解压。Windows 与 macOS 资产**没有代码签名或 notarization**，系统可能显示 SmartScreen 或 Gatekeeper 警告；哈希一致只能证明文件与该 Release 清单一致，不等于通用安全保证。

### 3. 检查版本并启动

```powershell
Expand-Archive $archive.FullName -DestinationPath ".\opencode2-v1.18.4-zhcn.2"
$exe = ".\opencode2-v1.18.4-zhcn.2\cli-windows-x64\bin\opencode2.exe"
& $exe --version
& $exe
```

Windows ARM64 用户把路径中的 `cli-windows-x64` 换成 `cli-windows-arm64`。版本必须精确输出
`opencode2 v1.18.4-zhcn.2`。如果目标路径不存在，请停止并回到 Release 资产说明核对平台，不要搜索并随意执行其它 `.exe`。

Linux 使用 `sha256sum`；macOS 默认使用 `shasum -a 256`。在 archive 与同一 Release 的 `SHA256SUMS` 所在目录执行，逐字比较所下载 archive 的哈希与清单中该文件的准确对应行（ARM64 按上表替换文件名）：

```bash
# Linux x64
sha256sum opencode2-linux-x64.tar.gz
grep -F '  opencode2-linux-x64.tar.gz' SHA256SUMS

# macOS Apple Silicon
shasum -a 256 opencode2-darwin-arm64.tar.gz
grep -F '  opencode2-darwin-arm64.tar.gz' SHA256SUMS
```

只有哈希完全一致才继续解压，再检查 `--version`；缺少对应行或哈希不一致时停止。

例如 Linux x64：

```bash
tar -xzf opencode2-linux-x64.tar.gz
./cli-linux-x64/bin/opencode2 --version
./cli-linux-x64/bin/opencode2
```

macOS 与 ARM64 用户按上表替换 archive 和目录名。首次执行前仍应先核对 SHA-256，并保留未签名/Gatekeeper 边界。

## 30 秒能力地图

本文使用以下固定归属标签：

- **`二开自研`**：由本 fork 拥有的行为或工具。
- **`二开可靠性加固`**：在 fork owner 上实施的维护、收尾或资源隔离。
- **`选择并适配上游`**：保留上游能力并完成 fork 集成；不宣称为本 fork 发明。
- **`可选二开插件`**：由用户另行安装和授权的 fork 插件，不是默认 Core。

| 你遇到的问题 | 本项目提供什么 | 归属 |
| --- | --- | --- |
| 中文入口零散 | 简体中文优先的 TUI 与普通命令界面 | `二开自研` |
| provider 看起来相似却行为不同 | 按 package、protocol、operation 选择 route | `二开自研` |
| 原生远程压缩容易被错误泛化 | OpenAI 与 xAI 各自严格、失败可见的 compact 路径 | `二开自研` / `二开可靠性加固` |
| 长任务跨进程重入 | Session 执行 lease、checkpoint 延续与直接子代理续跑 | `二开自研` |
| 本地程序发现和执行混在一起 | `environment_tools` 目录 + `direct_exec` argv 执行 | `二开自研` |
| 命令已退出但任务仍显示运行 | 子进程输出的单次确定收尾 | `二开可靠性加固` |
| 旧工作区仍占用 MCP 资源 | 仅活动工作区加载其 Location/MCP，正确处理主动关闭 | `二开可靠性加固` |
| 想从本地历史中找回上下文 | 有界 catalog/snapshot 分析流程 | `可选二开插件` |
| 插件、统计、后台 Job 等入口 | CLI/TUI 管理和多项交互改进 | `选择并适配上游` |

## 核心能力：问题、改变、结果与边界

### 中文优先，但不改写原始内容 — `二开自研`

- **问题**：关键菜单和普通命令反馈混用语言，会增加首次使用成本。
- **改变**：TUI 与普通命令面默认简体中文，英文仍可选择并作为字典回退。
- **结果**：导航、状态和常见操作更容易理解。
- **边界**：模型原文、代码、协议字段、ID 和原始工具输出不会为了“全中文”而被翻译或改写。

### Provider 能力诚实 — `二开自研`

- **问题**：显示名称、provider ID、model ID 或 `baseURL` 很相似，却不代表服务实现了同一协议与 operation。
- **改变**：能力由配置 package、所选 protocol 和 route 真正拥有的 operation 共同决定。
- **结果**：原生 OpenAI Responses、兼容 Responses、兼容 Chat 和 xAI Responses 不再互相继承未实现能力。
- **边界**：自定义 gateway 必须真实实现所选协议；改名或换 URL 不能获得原生 remote compaction、storage、WebSocket 或 hosted tools。

### 原生 OpenAI remote compaction — `二开自研`

- **问题**：把原生 OpenAI 和“OpenAI-compatible”混为一谈，会生成错误请求或在失败时悄悄改变语义。
- **改变**：原生 OpenAI 普通 Responses 在请求内使用 `context_management`；手动/恢复使用普通 Responses 的最终 `compaction_trigger` input item。
- **结果**：opaque checkpoint 可跨 turn 和重启继续，失败会明确停止，而不是静默改成本地摘要。
- **边界**：原生 OpenAI 路径**不会**调用 `/responses/compact`；兼容 Responses/Chat 只使用 local summary，不继承原生 checkpoint 权限。

### xAI compact 的单独边界 — `选择并适配上游` + `二开可靠性加固`

- **问题**：xAI Responses 的操作容易被错误授予 xAI Chat 或外观相似的 route。
- **改变**：选择上游 xAI Responses 基础能力，并由 fork 把 whitelist 与失败边界收紧；专用 route 每次 compact 只发起一次显式 `<baseURL>/responses/compact`。
- **结果**：operation owner 和失败位置可追踪。
- **边界**：xAI Chat、代理出来的相似 route 不自动拥有该能力；404、畸形响应或缺少可重放 item 都会显式失败，不 local fallback。

### Checkpoint 延续与请求投影裁剪 — `二开自研`

- **问题**：长对话需要降低发送负担，但不能把“少发给 provider”误解成删除历史。
- **改变**：opaque provider state/checkpoint 跨 turn 与重启重放；`compaction.prune` 只调整下一次 provider request projection。
- **结果**：可在正确 route 上延续 provider 状态，并减少请求携带的旧工具结果。
- **边界**：`prune` 不修改 SQLite 中的 durable history、export 文件或 TUI transcript；当前打开的长 transcript 仍可能继续增长。

### Session 与直接子代理续跑 — `二开自研`

- **问题**：同一 Session 被多个进程同时执行，或子代理只返回截断片段，会破坏长任务连续性。
- **改变**：一个 Session 同时只由一个进程执行；正常退出交接，崩溃后等待 lease 过期。父代理可用**准确 ID 和相同 agent**继续自己的 direct child，并接收完整最终结论。
- **结果**：长任务的执行 owner 和交接更明确，子任务可以继续而非从头复述。
- **边界**：不能接管任意、外部或任意嵌套 Session；子代理仍有上下文成本，完整 trace 留在 child 内。

### 发布与更新隔离 — `二开自研`

- **问题**：fork 若沿用上游 updater 身份，可能把用户带回不同服务、数据库或二进制来源。
- **改变**：`zh-cn` channel 与上游服务身份隔离；当前应用 update/upgrade 已禁用。
- **结果**：当前版本通过本 fork Releases 人工获取和校验；在 fork updater 仍禁用期间，后续更新也沿用这个入口。
- **边界**：没有自动 fork updater；`plugin update` 仅更新插件，与应用版本更新不是一回事。

## Provider 与 compaction 快速开始

全局配置位置：

- Windows：`%USERPROFILE%\.config\opencode\opencode.jsonc`
- POSIX：`~/.config/opencode/opencode.jsonc`
- `OPENCODE_CONFIG_DIR` 可显式指定配置目录；否则设置 `XDG_CONFIG_HOME` 时，以它替代默认 base。
- 项目根 `opencode.json(c)` 可以覆盖全局配置，`.opencode/opencode.json(c)` 又比项目根直接文件优先。

### 先选真实路线

| 你的服务实际提供什么 | 应选路线 | Compact 行为 |
| --- | --- | --- |
| 原生 OpenAI Responses | native OpenAI package | request 内自动 compact；最终 trigger 用于手动/恢复 |
| 通用 Responses-compatible HTTP | compatible Responses | local summary |
| 通用 Chat Completions | compatible Chat | local summary |
| xAI 专用 Responses 与 compact endpoint | xAI Responses | 一次显式 `/responses/compact` |

1. 复制并按注释修改 [`opencode.example.jsonc`](opencode.example.jsonc)。
2. 凭据只通过环境变量提供，不要把 key、Cookie 或真实 endpoint 写入仓库。
3. 在一次可丢弃 Session 中先验证普通请求，再手动执行 `/compact`；不要为了测试而伪造模型上限或堆出超大 prompt。
4. 若 remote compact 缺少 checkpoint/item 或失败，应先修 route 配置；不要期待静默 local fallback。

默认 compaction 设置为 `auto=true`、`prune=false`、`buffer=20000`、`keep.tokens=15000`。没有用户顶层 `compact_threshold`；阈值来自经核实的模型限制与 buffer。`keep.tokens` 只用于 local-summary tail。完整选择、验证方法和专业细节见 [Provider 与 compaction 指南](docs/provider-compaction.md)，稳定 whitelist 见 [CUSTOMIZATIONS.md](CUSTOMIZATIONS.md)。

## Session 备份、恢复与历史分析

这里有三个不同概念，不要混用。

### 可导入的内置 transfer

```bash
opencode2 export ses_exampleRootA > session-backup.json
opencode2 import session-backup.json --directory ./target-project
```

`ses_exampleRootA` 是合成占位 ID，使用时替换为你通过 TUI `Ctrl+P` → `复制会话 ID` 得到的准确值。

- 不带 `--sanitize` 的 export 是忠实的**私有备份**，可能含提示、推理、命令、路径、metadata 和 provider state。
- `opencode2 export <session> --sanitize` 会降低披露风险，但不是忠实对话备份，也不自动适合公开。
- 初学者应使用本地文件 import；URL import 是额外网络信任边界。

### 本地历史分析 — `可选二开插件`

安装并授权 `session-memory-v2` 后，恢复流程是：

1. 用 `session_catalog` 分页查找 root Session 标题与准确 ID；标题是不可信 metadata。
2. 只对选定 ID 调用 `session_snapshot`，得到临时 `navigation.json` 与 `snapshot.json`。
3. **先读 navigation**，再按最小相关范围读取 snapshot，不要整库预取。
4. 分析结束后调用 `session_snapshot` 的 `cleanup=true` 清理临时目录。

Snapshot 是临时分析投影，**不是**可 import 的备份；redacted 也不代表可公开。可识别的 binary/NUL 内容会在序列化和截断前被局部省略，身份损坏或真正无法安全表示的结构仍会 fail closed。完整命令、import 限制与隐私检查见 [Session 历史、导出与恢复](docs/session-history.md)。

### Session 分享

当前 V2 没有可工作的公开 share/unshare 入口。配置里可解析的 `share` 字段不能被当成发布或保护 Session 的功能。

## 长任务、子代理、MCP 与规则目录

一个可复用、但不绑定特定模型的工作流：

1. **建立状态**：记录目标、完成条件、当前 branch/revision、工作区状态和禁止触碰的范围。
2. **按 owner 拆任务**：只有互不重叠、可独立验证的工作才并行；为每个 direct child 保留准确 ID 和 agent。
3. **保存决策而非复制聊天**：运行时会提供一个 root Session rules-directory 位置提示，root 与 descendants 可共享。可把 [工作流模板](docs/workflow-template.md) 复制到该目录，记录计划、决定和 handoff。
4. **在正确工作区使用 MCP**：仅为当前活动 workspace 配置所需 MCP；显式打开第二 workspace 会建立它自己的 eager MCP set。
5. **持续任务用同一 child 接续**：传入准确 direct-child ID，不创建假冒的新 child；最终让 child 返回完整结论。
6. **逐 owner 验证并交接**：记录命令、结果、未验证项和恢复路径，再由拥有外部权限的人决定 commit、push 或 release。

Rules directory 只是运行时提供的优先位置提示：它不会自动创建文件、读取内容、校验计划或同步状态，也不应在公开示例中硬编码真实 Session ID。可直接使用的公开模板见 [workflow template](docs/workflow-template.md)；项目 Agent 接手规则见 [`AGENTS.md`](AGENTS.md) 与 [接手指南](docs/agent-takeover.md)。

`opencode.session_move` 是 `选择并适配上游` 的 Code Mode 工具，fork 将它收窄为只可移动当前 Session 或当前 Session 拥有的 direct child；移动会在安全边界生效，同一次调用后不要继续依赖旧目录。

## 本地工具快速开始

### `environment_tools` — `二开自研`

**问题 → 改变 → 结果 → 边界：** 模型经常反复搜索同一程序，或把“没找到”误说成“没安装” → 工具记忆已经成功解析或重新核实的外部程序目录项 → 后续可用稳定 catalog ID 指代 executable → 它不是 installed-software scanner；目录缺项不证明程序未安装，目录成员资格也不授予执行权。

典型步骤：

1. `environment_tools` 按具体名称查询 catalog。
2. 命中 active 且 direct-exec eligible 的项时，取得返回的准确 catalog ID。
3. 若未命中，再用受控方式发现程序；只有成功解析/执行后才更新 catalog。

### `direct_exec` — `二开自研`

**问题 → 改变 → 结果 → 边界：** 原始 shell 字符串容易混入管道、重定向和 quoting 语义 → `direct_exec` 只接受 catalog ID 与分离的 argv → 简单原生前台执行更明确 → 它**不是 sandbox**，也不接受 raw executable path、shell command line、pipeline、redirect、stdin、调用方自定义环境变量或 background mode。

需要 shell 语法、脚本、stdin、自定义环境或后台任务时，应使用明确授权的 shell/terminal owner，而不是把整个命令行塞进一个 argv。

## 可靠性与资源管理

这里只描述可观察行为，不给出缺少代表性基准的速度或内存百分比。

- **进程输出收尾 — `二开可靠性加固`**：短时 Grep、命令或 MCP stdio child 可能已经退出，但 stream 没有发出预期 `end`，让工具和 Session 看起来一直在运行。共享 capture owner 会在受支持的 end/close/exit 路径上只 settle 一次，同时保留已收集输出、backpressure 与 Windows process-tree cleanup。结果是“进程结束时本地搜索/命令能够结束”，不是“Grep 更快”。
- **活动工作区 MCP 隔离 — `二开可靠性加固`**：历史 tab 不再为非活动 workspace 构造完整 MCP set；owner 主动关闭不会立即被当成故障重新获取，意外崩溃仍可见。显式打开第二 workspace 仍会创建独立 eager MCP set；MCP 不是 lazy，也不是跨 workspace 全局共享。
- **关闭 Session 的 cache 释放 — `二开可靠性加固`**：关闭一个 Session family 的最后 tab 后，可释放其进程内 conversation cache，durable history 仍在 SQLite。它不限制当前打开 transcript 的增长。
- **完成 Job 的输出保留 — `二开可靠性加固`**：已完成 shell/subagent Job 的 process-local 输出不会无限累计；仍在运行的 Job 不会被驱逐。
- **其他资源工作 — `选择并适配上游`**：recent Session retention、transcript remount 计算、App inactive-tab loading 与 file-content LRU 作为上游改进被选择并集成，不宣称为 fork 发明。

## 完整功能矩阵

| 领域 | 入口 / 改变 | 归属 | 重要边界 |
| --- | --- | --- | --- |
| Plugin | CLI/TUI list、add、check、update、remove | `选择并适配上游` | 插件是独立信任边界；`plugin update` 不更新应用 |
| 统计 | TUI `/stats` 与 CLI `stats` | `选择并适配上游` | 统计不是性能保证 |
| 命令代理 | command subagents、background Jobs 与 fork continuation 集成 | `选择并适配上游` | 持续 child 只按准确 direct-child 身份续跑 |
| Session ID | TUI `Ctrl+P` 打开命令面板后选择 `复制会话 ID`；App/WebUI 也有 Copy Session ID | `选择并适配上游` | TUI `/copy` 是复制 transcript，不是复制 Session ID |
| 应用更新 | root `update` 是 `upgrade` alias | `选择并适配上游` | 当前 fork app updater 禁用；不安装 fork 或上游更新 |
| Worktree | drafting、preview 与 Session navigation 改进 | `选择并适配上游` | 仍需用户明确目录与 Git 操作权限 |
| Terminal | persistent panes | `选择并适配上游` | Windows 默认关闭，因为所需 PTY 支持未随当前产物提供 |
| App/WebUI | navigation、settings、timeline、inactive-tab loading | `选择并适配上游` | 当前 Release 是 CLI archives，不是 Desktop installer |
| Session move | Code Mode pinned `opencode.session_move` | `选择并适配上游` | 仅当前 Session 或 owned direct child |

<details>
<summary>较小的交互改进</summary>

- 多个界面使用一致的关闭 `x`；
- prompt arrow 与正文隔离，减少导航歧义；
- MCP 状态具有明确 click target；
- background child 提供父/子双向导航；
- compaction 状态、准确 child ID、preview 与 timeline 入口得到整理。

这些是辅助体验，不改变 provider、Session 权限或安全边界。
</details>

## GPT-5.6 开发来源与 Agent 接手

截至本里程碑，fork 特有开发工作由 **GPT-5.6 agents** 全程承担，包括需求分析、源码调查、实现、验证、review 协调、文档以及经授权的 release operations；用户保留产品决策与所有外部发布授权。

这项来源说明仅覆盖 fork-specific 工作：不表示 GPT-5.6 创作了上游 OpenCode 或第三方依赖，不保证正确性或安全性，不要求未来贡献者使用相同模型，也不构成 OpenAI、anomalyco 或上游项目背书。模型身份不能替代 focused tests、独立审阅和人工发布决策。

新的 coding agent 应先读：

1. 根目录 [`AGENTS.md`](AGENTS.md)：简短、规范性的仓库协作合同；
2. [`docs/agent-takeover.md`](docs/agent-takeover.md)：状态检查、证据、隐私、恢复和 handoff；
3. [`docs/workflow-template.md`](docs/workflow-template.md)：可选的通用目标/DAG 工作模板；
4. [`CUSTOMIZATIONS.md`](CUSTOMIZATIONS.md)：不能在同步中悄悄丢失的产品边界。

编辑或测试权限从不自动包含 commit、push、PR、merge、deploy 或 release 权限。

## 发布、校验与更新

- **当前公开源码**：`main` 会继续接收清理后的 source snapshot 和公开文档提交，不能用 README 中写死的 SHA 代替实时分支状态。
- **当前二进制**：`v1.18.4-zhcn.2` 是已发布并完成下载核验的 prerelease，包含六个原生 CLI archives；该 Release 精确绑定源码 commit `946cf3501b8c8c545735ba98366b5bf863ffae30`，channel 为 `zh-cn`。
- **当前源码运行时**：Bun **1.4.2**，CLI 默认启用 `bytecode: true`。Bytecode 通常以更大的 EXE 换取较少的启动解析成本，不代表固定的速度或内存收益。
- **验证范围**：[GitHub Actions 发布运行](https://github.com/521ox/opencode2-zh-CN/actions/runs/34554678273)的六个原生构建 job 与最终汇总发布 job 全部成功，覆盖版本、help、内嵌 Bun revision、完整产物及隔离服务生命周期检查。发布后的 14 个上传资产已实际下载，核对 GitHub digest、清单与哈希，并检查 archive 内可执行文件、包信息及 PE/ELF/Mach-O 平台架构；不构成广泛稳定性承诺。
- **已发布资产运行时**：`.2` 的六平台 archives 均为 Bun **1.4.2**（revision `744846f844374847c902b5e7fd59b4342a51ef99`），`bytecode: true`，内嵌完整 WebUI。历史 `v1.18.4-zhcn.1` 仍绑定源码 `6718a6fef1e80d79e028d0d9fe95c28216418637` 和 Bun **1.3.14**，保留作回退选项，原资产未替换。
- **资产证据**：六个 archive、六个 schema-v2 sidecar、`release-manifest.json` 和 `SHA256SUMS` 共 14 个上传资产（GitHub 自动提供的源码包另计），绑定源码 commit、版本、channel、Bun revision、bytecode、runner/target、archive/executable 大小和 SHA-256。
- **签名与稳定性**：Windows/macOS 未签名；没有 installer、notarization、stable 或 reproducible-build 承诺。
- **更新方式**：应用 updater 禁用。用户应返回本 fork Releases，重新下载并校验；上游 updater、installer 或 npm CLI 不是本 fork 更新来源。
- **上游状态**：已选择性审查到上游 [`0808ebc3`](https://github.com/anomalyco/opencode/commit/0808ebc3c52286f5a3a602f82f069ae597f86469)。它不是本 fork 的直接祖先，“审查到”也不表示范围内全部改动已采用。

周期性 source snapshot 与二进制 Release 是不同发布层：后续 `main` 文档提交不会改变版本化 Release 的 tag、产物源码 SHA 或已发布字节；源码提交本身不证明所有构建检查通过。已发布 archive 的证据应以对应 Release 的清单和 sidecar 为准，第三方 rebuild 不在本仓库发布资产支持承诺内。维护者流程见 [发布指南](docs/releasing.md)。

## 从源码运行与贡献

前置条件：Git、[Bun](https://bun.sh/) **1.4.2**（以根 `packageManager` 为准），以及目标平台需要的本机构建依赖。

```bash
git clone https://github.com/521ox/opencode2-zh-CN.git
cd opencode2-zh-CN
bun install --frozen-lockfile
bun dev
```

Windows 请先用 Bun 1.4.2 执行 `bun install --frozen-lockfile --linker hoisted`。Windows x64 构建 wrapper 默认使用 `Current`，从 `%LOCALAPPDATA%\opencode-build\bun\1.4.2\bin\bun.exe` 读取隔离工具链，不自动安装依赖或下载 Bun；也可以显式指定你已安装的确切 1.4.2：

```powershell
# 在仓库根目录执行；先确认所选 Bun 的 --version 精确为 1.4.2。
$buildBun = (Get-Command bun.exe).Source
& $buildBun install --frozen-lockfile --linker hoisted
pwsh -File .\script\build-custom-windows.ps1 -BuildBun $buildBun
```

若已预备默认 cache 中的 Bun 1.4.2 并安装依赖，可省略 `-BuildBun`。Wrapper 严格检查版本，只临时调整构建进程的 PATH，不修改全局 Bun；默认导出到仓库内已忽略的 `dist/windows-x64`。编译后会探测内嵌 runtime 并核对构建 metadata。详细前置条件见 [CONTRIBUTING.md](CONTRIBUTING.md)。

根聚合测试入口被故意阻止，避免混合不同 package 的无边界测试。修改代码时，从 owner package cwd 执行最小相关检查，例如：

```bash
bun --cwd packages/core run typecheck
bun --cwd packages/core test test/config/compaction.test.ts
bun --cwd packages/ai run typecheck
bun --cwd packages/ai test test/provider/compaction.test.ts
```

具体要求见 [CONTRIBUTING.md](CONTRIBUTING.md)。贡献、源码 snapshot 和 Release 是不同权限边界；未来二进制发布仍由拥有外部权限的人手动触发并审计，不因 PR 合入而自动发生。

## 安全、隐私、上游与许可

OpenCode2 可在用户授权下读写文件、执行进程并访问网络；它不是安全 sandbox。请使用最小操作系统权限，审阅 provider、gateway、MCP、plugin 和工具权限，并在允许写操作前备份重要工作。

不要提交或公开 API key、Cookie、authorization header、真实 endpoint、prompt、Session 数据库、未审阅 export/snapshot、日志或本机路径。Session snapshot 即使 redacted 仍可能含敏感上下文。

- fork 特有普通缺陷：[GitHub Issues](https://github.com/521ox/opencode2-zh-CN/issues)
- fork 私密漏洞：[GitHub Security Advisories](https://github.com/521ox/opencode2-zh-CN/security/advisories/new)
- 同时影响上游的漏洞：按上游 [SECURITY.md](https://github.com/anomalyco/opencode/blob/v2/SECURITY.md) 私密报告
- 安全与支持范围：[SECURITY.md](SECURITY.md)
- 公告与归属：[NOTICE.md](NOTICE.md)
- 稳定定制合同：[CUSTOMIZATIONS.md](CUSTOMIZATIONS.md)
- 许可：[MIT License](LICENSE)

## 社区与友链

- [LINUX DO](https://linux.do) — 开放友好的技术交流社区。

## English summary

OpenCode2 zh-CN is an independent, community-maintained OpenCode V2 fork for Chinese and Windows users. It provides a Simplified Chinese-first interface, explicit provider/protocol capability boundaries, route-specific compaction behavior, long-Session and direct-child continuation, controlled local-tool execution, and optional local history analysis. Current source requires **Bun 1.4.2**, with CLI bytecode enabled by default. The current public prerelease is **`v1.18.4-zhcn.2`**, with six native CLI archives built from `946cf3501b8c8c545735ba98366b5bf863ffae30` using Bun 1.4.2, bytecode, and the full embedded WebUI. All six native build/runtime/service gates and the publication job passed; all 14 uploaded assets passed post-download verification. This is not a broad stability guarantee. Windows and macOS assets are unsigned, and the application updater is disabled. Updates come only from this fork's Releases page; historical `.1` assets remain unchanged. The fork is selectively reviewed through upstream `0808ebc3`, which is not a direct ancestor and does not imply complete adoption. This project is not affiliated with or endorsed by anomalyco, upstream OpenCode, or OpenAI.
