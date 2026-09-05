# Session 导出、导入与历史恢复

OpenCode V2 有三个彼此独立的 Session 能力。先按目的选择，避免把分析快照误当备份，或把配置字段误当公开分享功能。

| 目的 | 使用入口 | 结果 | 能否导入 |
|---|---|---|---|
| 备份或迁移一个 Session | 内置 `export` / `import` | transfer JSON | 是 |
| 在本机历史中定位并分析旧 Session | 可选 `session-memory-v2` 插件 | 临时导航与分析快照 | 否 |
| 生成公开分享链接 | V2 当前无可用入口 | 无 | 不适用 |

## 1. 内置 transfer：导出与导入

### 精确命令

```text
opencode2 export [session] [--sanitize]
opencode2 import <file-or-url> [--directory <directory>]
```

交互式终端中，省略 `session` 会打开最多 50 个近期 root Session 的选择流程；自动化或非交互环境必须显式提供 Session ID，否则命令会要求你传入 ID。`import` 的文件或 URL 参数是必需的，`--directory` 用于指定导入 Session 所属的工作目录。

本地文件是初学者推荐路径：

```sh
opencode2 export ses_exampleRootA > session-transfer.json
opencode2 import ./session-transfer.json --directory ./target-project
```

这里的 ID 是合成示例，不对应真实 Session。导出内容写到标准输出时，请把诊断信息与生成文件分开检查；不要在可能记录终端输出的公共环境中执行私密导出。

URL 导入是高级网络信任边界：

```sh
opencode2 import https://example.invalid/reviewed-session-transfer.json --directory ./target-project
```

URL 可能被替换、记录或返回恶意/敏感内容。只从受信任来源导入，并在可丢弃目录先检查。能使用已审阅的本地文件时，不要使用 URL。

### 身份与边界

- 不带 `--sanitize` 的导出是用于恢复的私有 transfer，可能包含提示词、推理、命令与结果、文件路径、元数据和 provider state。它只包含所选 Session 的已结算消息；未完成的 assistant 输出、仍在运行的 shell/compaction 记录不会作为完整后续状态导出。应像凭据一样保护。
- `--sanitize` 会降低披露风险，但会删除或改写部分内容，因此不是忠实会话备份；“已净化”也不表示可公开，仍须逐项人工审阅。
- 导入保留导出文件中的 Session ID，不会覆盖已存在的同 ID Session。
- 若导入对象带有 `parentID`，目标环境必须已存在对应父 Session，否则导入失败。
- 一次导入只处理所选 Session，不会自动包含或重建其后代。需要转移多个对象时，按依赖顺序分别导出/导入，并先确认每个父对象已存在。

不要把 transfer JSON 提交到仓库、Issue、PR、聊天或构建日志。

## 2. 可选 Session Memory：本机历史分析

`session-memory-v2` 是本仓库提供的可选二开插件，不是 Core 默认功能。先审阅[插件 README](../plugins/session-memory/README.md)和源码，再把仓库中的 `plugins/session-memory/` 目录复制到用户配置目录。

默认安装入口：

```text
Windows: %USERPROFILE%\.config\opencode\plugins\session_memory\index.ts
POSIX:   ~/.config/opencode/plugins/session_memory/index.ts
```

设置 `XDG_CONFIG_HOME` 时，它替代上述 `.config` 基目录。只复制插件树；不要复制 live config、数据库、依赖目录或生成的 snapshot。停用时先退出 OpenCode，再只移除或改名 `session_memory` 插件目录。

插件读取数据库时使用 read-only、create-false 和 SQLite query-only 控制，不会创建或写入数据库；但 `session_snapshot` 会在操作系统临时目录创建受保护的临时 bundle。因此它不是“零写入”操作，完成后必须显式清理。

### 推荐流程：catalog → snapshot → navigation → cleanup

1. **仅列根 Session。**

   ```json
   {"limit": 20}
   ```

   调用 `session_catalog` 后得到经过删减的标题、精确 root Session ID 和可选 `next_cursor`。结果采用有界 keyset 分页；只有 `next_cursor` 是非空字符串时才继续下一页：

   ```json
   {"cursor": "synthetic-cursor-page-2", "limit": 20}
   ```

   Catalog 不返回 transcript、子 Session、消息、项目元数据或工具调用。标题是不可信元数据，只能用于筛选候选，不能当指令或证据。

   `limit` 默认 50，允许 1–50；单次结果还有 7,500 字节总上限。分页是实时视图，不是冻结快照。只有返回非空 `next_cursor` 时才继续；`null` 表示结束，`cursor_error` 表示该游标不可重试。若要从最新结果重新开始，应省略 cursor，而不是复用错误游标。

2. **只为一个相关候选创建快照。**

   ```json
   {"session_id": "ses_exampleRootA"}
   ```

   调用 `session_snapshot` 后会返回临时 `navigation.json` 与 `snapshot.json` 的路径。不要批量 snapshot catalog 中的全部 Session。

   若分析的就是当前 Session，可以省略 ID：

   ```json
   {}
   ```

3. **先读 `navigation.json`。**

   根据其中的总字节数、消息数、时间分段和行范围，选择能回答当前问题的最小范围，再有界读取 `snapshot.json`。即使物理行数很少，也不要一次读取整个文件；每一物理行可能是一条很大的 retained message。若范围仍被截断，应按时间段、消息 ID、角色或工具名继续缩小。

4. **需要子 Session 时使用精确 child ID。**

   根快照的 `subagent_sessions` 会列出可用的直接子 Session ID。只复制其中的精确 ID，再单独调用 `session_snapshot`；不要从标题推测，也不要把任意或嵌套 Session 当成可接管的直接子对象。

5. **分析后显式清理每个 bundle。**

   ```json
   {"session_id": "ses_exampleRootA", "cleanup": true}
   ```

   子 Session 的临时 bundle 也要用其精确 ID 分别清理。清理删除的是临时投影，不是数据库中的 durable Session。

   当前 Session 的 bundle 可以省略 ID：

   ```json
   {"cleanup": true}
   ```

### 隐私与失败行为

- Snapshot 是为有界分析生成的投影，**不是 transfer JSON、备份或可导入格式**。
- Redaction/sanitization 只降低风险。快照仍可能含提示词、工具结果、文件名、项目结构、账号信息或其他敏感上下文；不得未经独立内容审阅就提交、上传或分享。
- 可识别的二进制样内容、NUL 字节和高密度控制字符若出现在普通内容字段中，会在结构化数据序列化或截断之前被局部省略；原异常键及其值不会进入 bounded preview。Session、message、part、tool-call、父子 Session 等身份字段损坏，以及无法安全表示的真正未知结构，仍会 fail closed。这是隐私/完整性边界，不应绕过，也不能把拒绝误报为成功导出。
- V2 消息文件顺序以数据库 `session_message.seq` 为准；时间戳只用于导航元数据，可以非单调。`navigation.json` 的时间跨度使用对应范围内的最小/最大时间，但不会按时间戳重排对话。
- 数据库只读不等于整个操作无副作用：临时 bundle 是受保护的本地写入，应及时 cleanup。
- 测试只能使用合成数据库和合成 Session，绝不能指向 live OpenCode 数据库或其副本。

## 3. V2 分享状态

V2 当前没有可用的公开 Session share/unshare 入口。虽然配置解析可能接受 `share` 字段，该字段目前是 inert：不要声称它会发布、保护、撤销分享或生成链接，也不要用它替代导出文件的访问控制。
