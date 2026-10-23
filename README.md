# dsh-session-prompt

会话级系统提示词注入。给你自己一段"只对本会话生效、每轮都在、不会被压缩掉"的约束。

## 安装

```bash
# 装到 web profile（打 tag 的版本）
dsh plugin --profile web add "github:PrismLean/dsh-session-prompt#v0.1.0"

# 升级：先 remove 再 add
dsh plugin --profile web remove dsh-session-prompt
dsh plugin --profile web add "github:PrismLean/dsh-session-prompt#v0.1.0"
```

装完重启 `dsh web` 生效。卸载同理，`remove` 后重启。

## 界面入口

输入框下方工具栏，**「会话权限」控件右侧**有一个按钮（图标 + 文字「提示词」）：

- 未设置时只显示图标；设置后按钮高亮并显示「提示词」。
- 点击弹出悬浮层，内含 textarea、字数计数、`取消` / `清空` / `保存`。
- 保存后**下一轮请求立即生效**，无需重启。

## 三种写入通道

| 通道 | 谁用 | 说明 |
|---|---|---|
| UI 悬浮层 | 人 | 作用于当前打开的会话，不走 agent 权限 |
| `/session-prompt <文本>` | 人 / agent | 悬浮层保存时实际提交的命令；文本可含换行 |
| `session_prompt` 工具 | 顶层 agent | 只能写**自己的子代理**，不能写自己 |

## 权限矩阵（代码硬校验，不依赖描述）

| 写入方 | 能写谁 |
|---|---|
| 用户（UI） | 当前打开的会话 |
| 主代理（delegationDepth = 0） | 仅自己的子代；写自己 → 拒绝 |
| 子代理（delegationDepth ≥ 1） | 谁都不行 |

## 配置

```jsonc
// ~/.dsh/profiles/<profile>/package.json → dsh.profile.configs 或 cordis.patch.yml
{
  "dsh-session-prompt": {
    "enabled": true,
    "maxChars": 2000,   // 建议上限：超出只提示成本，不拒绝、不截断
    "order": 700        // system prompt 段序，默认落在 TEAM_POLICY(600) 与 PTC_ONLY(800) 之间
  }
}
```

> 配置项**不要**用 `.volatile()`。它会把字段变成 getter/setter 描述符对象，导致数值比较全部失效。

## 长度限制

| 通道 | 上限 |
|---|---|
| 悬浮层输入框 | **2000 字符硬上限**，达到后无法继续输入，计数器显示 `x / 2000` |
| `/session-prompt` 命令 | 不拒绝；超 `maxChars` 时完整保存并返回每轮 token 开销提示 |
| `session_prompt` 工具 | 同上 |

两条通道策略不同是有意的：悬浮层是人手输入的日常入口，硬上限省得你边写边算成本；命令和工具是程序化通道，静默丢弃比多付 token 更危险，所以只提示、不阻断。

## 三个必须知道的代价

1. **每轮付费，永不折叠。** 文本进 system 段，不参与压缩，所以才有上面那个提示。
2. **改一次 = 一次前缀 cache miss。** system 段位于缓存前缀最前，文本一变，从第一个变化 token 起整个前缀不可复用。
3. **fork 子代理不继承。** 投影 `apply` 丢弃 `seq < inheritedEventCount` 的事件，所以 fork 出来的子代理从空提示词开始；spawn 子代理本来就是全新会话。

## 数据形态

```jsonc
// 事件
{ "type": "sessionPrompt/write", "data": { "text": "..." } }
// 投影 state
{ "text": "..." }
```

状态只存在于会话事件流里，会话结束即消失，不写任何全局文件。

## 验证

```bash
node --test test/*.test.js   # 17 项
```
