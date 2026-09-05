# Provider 线路与上下文压缩配置

本指南帮助初次配置 OpenCode V2 的用户选择真实协议线路。Provider 显示名、provider ID、model ID 或熟悉的 `baseURL` 都不会赋予线路额外能力；能力来自所选 package 与其实际 route/protocol。

可复制的完整全局模板见 [`opencode.example.jsonc`](../opencode.example.jsonc)。不要从 live config 删减后发布示例，也不要把密钥写进 JSONC 或提交 `.env`。

## 1. 全局配置放在哪里

| 环境 | 默认全局文件 |
|---|---|
| Windows | `%USERPROFILE%\.config\opencode\opencode.jsonc` |
| POSIX | `~/.config/opencode/opencode.jsonc` |

如果设置了 `OPENCODE_CONFIG_DIR`，它会显式指定配置目录；否则，非空的 `XDG_CONFIG_HOME` 会替代默认配置基目录。项目根的 `opencode.json(c)` 可以覆盖全局配置，`.opencode/opencode.json(c)` 又比项目根直接文件优先。排查“配置未生效”时必须检查最终合并结果，而不是只看全局文件。

建议先复制公共模板，在 shell/凭据管理器中设置模板引用的环境变量，然后用可丢弃项目和新 Session 验证。环境变量示例只表示占位，不应把真实值粘贴进文档、命令历史、日志或仓库。

## 2. 初学者线路决策表

| 需求 | 精确 package / route | 压缩方式 | 关键边界 |
|---|---|---|---|
| 通用 Chat Completions gateway | `@opencode-ai/ai/providers/openai-compatible` | local summary | 不是 Responses；不继承 remote compaction |
| 通用 Responses-compatible gateway | `@opencode-ai/ai/providers/openai-compatible/responses` | local summary | 强制兼容线路边界；无 native checkpoint authority |
| 真正实现 OpenAI Responses 扩展的 OpenAI/gateway | `@opencode-ai/ai/providers/openai` | native OpenAI remote | 普通 Responses 使用 `context_management`；失败不降级 |
| 官方 xAI Responses | `@opencode-ai/ai/providers/xai` 的 dedicated Responses route | xAI explicit remote | 明确调用 `/responses/compact`；xAI Chat 不支持 |

`aisdk:@ai-sdk/openai` 在本 fork 中也映射到 generic compatible Responses，而不是获得 native OpenAI remote compaction。DeepSeek、Anthropic、Azure、Modal、Copilot、xAI Chat 和其他未明确授予操作的线路使用 local summary。

### Compatible Chat 示例

```jsonc
{
  "model": "compat-chat/replace-with-model-id",
  "providers": {
    "compat-chat": {
      "package": "@opencode-ai/ai/providers/openai-compatible",
      "env": ["COMPAT_CHAT_API_KEY"],
      "settings": {
        "apiKey": "{env:COMPAT_CHAT_API_KEY}",
        "baseURL": "{env:COMPAT_CHAT_BASE_URL}"
      },
      "models": {
        "replace-with-model-id": { "name": "Replace with provider model ID" }
      }
    }
  }
}
```

### Compatible Responses 示例

```jsonc
{
  "model": "compat-responses/replace-with-model-id",
  "providers": {
    "compat-responses": {
      "package": "@opencode-ai/ai/providers/openai-compatible/responses",
      "env": ["COMPAT_RESPONSES_API_KEY"],
      "settings": {
        "apiKey": "{env:COMPAT_RESPONSES_API_KEY}",
        "baseURL": "{env:COMPAT_RESPONSES_BASE_URL}"
      },
      "models": {
        "replace-with-model-id": { "name": "Replace with provider model ID" }
      }
    }
  }
}
```

两种 compatible 线路都使用 local summary。把 provider 命名为 `openai`、使用 `/responses` 风格 URL，或复制 native 字段，都不会改变这一点。

### Native OpenAI Responses 示例

完整主示例在[全局模板](../opencode.example.jsonc)中。核心选择是：

```jsonc
{
  "package": "@opencode-ai/ai/providers/openai",
  "env": ["OPENAI_GATEWAY_API_KEY"],
  "settings": {
    "apiKey": "{env:OPENAI_GATEWAY_API_KEY}",
    "baseURL": "{env:OPENAI_GATEWAY_BASE_URL}"
  }
}
```

只有 gateway 真正实现 ordinary Responses 上的 `context_management`、opaque checkpoint 和最终 `compaction_trigger`，此线路才可用；仅接受并忽略字段不算兼容。

### Official xAI Responses 示例

模板提供一个不设置自定义 `baseURL` 的官方 xAI alternative：

```jsonc
{
  "package": "@opencode-ai/ai/providers/xai",
  "env": ["XAI_API_KEY"],
  "settings": { "apiKey": "{env:XAI_API_KEY}" }
}
```

只有 dedicated xAI Responses route 拥有 explicit compact operation。xAI Chat、相似名称或任意 proxy URL 不会自动获得它；proxy 若不实现该 endpoint，会显式失败。

## 3. 共享 compaction 配置

当前 V2 字段和默认值：

```jsonc
{
  "compaction": {
    "auto": true,
    "prune": false,
    "buffer": 20000,
    "keep": {
      "tokens": 15000
    }
  }
}
```

- `auto` 控制达到压力阈值时的自动压缩。
- `buffer` 为请求保留余量。模型限制必须来自 provider 的可靠文档或实际元数据，不能猜测。
- `keep.tokens` 只控制 **local-summary** 路径保留的 tail；它不控制 remote checkpoint。
- `prune` 默认关闭。开启后只改变发送给 provider 的请求投影，不会删除 SQLite durable history、导出内容或 TUI transcript。
- **没有顶层 `compact_threshold` 配置字段。** 不要把 wire 字段复制到全局 JSONC。

<details>
<summary>进阶：运行时如何计算 remote threshold</summary>

设 `B = compaction.buffer`，运行时根据已解析模型限制计算 prompt ceiling：

```text
min(inputLimit - B,
    contextLimit - max(min(outputLimit, 32000), B))
```

缺少 `inputLimit` 时该项按无穷大处理。结果必须是正 safe integer，否则不启用 remote threshold。自定义模型只有在 provider 元数据不可靠或缺失且你有权威数值时才应补充 `limit.context`、`limit.input`（存在独立输入上限时）和 `limit.output`；错误值会产生错误阈值。模板故意不猜任何模型限制。

</details>

## 4. 不同线路实际发生什么

### Native OpenAI：ordinary Responses 内完成

- 普通生成请求可在 `context_management` 中携带计算后的 `compact_threshold`。
- 自动 checkpoint 会持久保存，并在后续 turn 或进程重启后作为 opaque provider state 重放。
- 用户执行 `/compact`，或自动 checkpoint 缺失/上下文 overflow 的有界恢复，会向普通 `/responses` 请求追加最终 `{ "type": "compaction_trigger" }` input item。
- Native OpenAI **永远不调用 `/responses/compact`**。缺失、多个、畸形或未加密 checkpoint，以及 provider/cancellation failure 都可见；不会静默改用 local summary。

### Official xAI Responses：显式 compact operation

- 阈值 crossing 或手动 `/compact` 会在普通 generation 前恰好调用一次所选 `<baseURL>/responses/compact`。
- 返回的 opaque `encrypted_content` checkpoint 会持久保存并在后续请求重放。
- 404、错误响应、畸形或缺失 compaction item 会显式失败，不替换 durable transcript，也不 local fallback。
- xAI Chat 没有此操作，仍走 local summary。

### Compatible routes：只做 local summary

Compatible Chat 与 compatible Responses 的自动/手动压缩都由本地摘要路径完成。Provider 名称、model ID、route 标签或 `baseURL` 不能把它们升级为 native OpenAI 或 dedicated xAI 权限。

## 5. 手动压缩、恢复与安全验证

在交互界面使用：

```text
/compact
```

这会沿当前线路选择 remote checkpoint 或 local summary，不会绕过线路边界。Remote failure 保持可见，不会以本地摘要伪装成功。

安全验证应使用可丢弃的目录、新 Session、非生产凭据/最小权限凭据和已审阅的测试输入：

1. 确认全局与项目配置合并后的 package、route 和 model limits。
2. 在远低于真实上下文压力的小型 Session 中验证普通 generation。
3. 手动执行一次 `/compact`，确认成功或预期的显式错误。
4. 成功后再发一个无敏感信息的 turn，确认 checkpoint/summary 可继续使用。
5. 退出并重新打开该测试 Session，确认 continuation 行为。
6. 删除可丢弃的测试数据时，只使用产品支持的精确目标操作；不要把验证指向 live Session 或生产数据库。

不要为了“测试自动阈值”猜小模型上限、制造超大 prompt、重放失败的生产请求、修改 live SQLite，或抓取包含 Authorization/header/prompt 的流量。安全验证无法证明任意 gateway 完全兼容；它只证明被测 package、endpoint 和凭据当时的有界路径。
