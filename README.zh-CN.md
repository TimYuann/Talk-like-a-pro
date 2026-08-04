# Talk like a Pro

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![English](https://img.shields.io/badge/English-README-blue.svg)](README.md)

> 模糊需求进，精确 prompt 出。不打扰，不阻塞，必要时问你几个问题。
> Vague request in, precise prompt out.

Pi 扩展：检测用户的模糊需求（如 `帮我弄一下 auth`、`修一下 login bug`），探索项目上下文，必要时追问澄清，最终产出交给编码 agent 的精确 prompt。

## 它做什么

当用户输入类似 `帮我弄一下 auth` 或 `修一下 login bug` 时：

1. **启发式预筛选** — 短句 / 含模糊动词的输入进入候选；含具体路径或动词的输入直接跳过
2. **上下文探索** — 收集 `cwd`、`git status --short`、`AGENTS.md` / `CLAUDE.md`、最近 6 条会话记录
3. **LLM 意图分析** — 调用配置的分析模型（按模型过滤思考强度）判断清晰度：产出 refined prompt，或生成澄清问题
4. **多轮问答**（意图模糊时）— `ctx.ui.select` 选选项 + `ctx.ui.input` 自由输入
5. **二次合成** — 携带用户回答再调一次 LLM，产出最终 refined prompt
6. **Transform** — refined prompt 替换原始输入；编码 agent 永远不会看到模糊版本

所有失败路径（LLM 报错、解析失败、用户取消）一律回退为 `pass through`，绝不阻塞用户。

## 设置（TUI）

```
/talk-like-a-pro               → 打开设置界面
/talk-like-a-pro on|off|status
/talk-like-a-pro level 1|2     (beginner|standard / 入门|标准)
/talk-like-a-pro model <provider/id> | follow-current
/talk-like-a-pro effort <off|minimal|low|medium|high|max>
```

| 设置项 | 值 | 默认 | 作用 |
|---|---|---|---|
| 启用翻译 | on / off | **on** | 总开关；关闭时 `/!!` 仍可强制翻译 |
| 翻译层级 | 1 入门 / 2 标准 | 2 | 决定 refined prompt 的产出形态（见下） |
| 分析模型 | 跟随当前模型 / 可用模型 | 跟随当前模型 | 哪个模型做意图分析 |
| 思考强度 | 随模型支持列表 | minimal | 分析调用的 `reasoningEffort`，按模型过滤 |

配置持久化到 `~/.pi/agent/extensions/talk-like-a-pro.json`。启用时页脚显示 `● TLAP Lx` 状态指示。

层级差异（定义在 `LEVEL_PROMPT_BLOCKS`）——两档的区别在**最终产出物**：

- **1 入门（Beginner）** — 产出*完整任务书*（保姆级）：一句话意图 + 隐含需求 + 具体要求≥4条（含边界/不做的事）+ 上下文（文件、约定、用户背景假设）+ 验收标准≥3条可验证。追问最多 3 个，口语化带选项。
- **2 标准（Standard）** — 产出*高效补充式 prompt*：一句话意图 + 2-3 条具体要求 + 上下文 + 2 条验收标准。只补原始请求缺的关键信息。追问 1-3 个。

分析模型的候选列表来自当前会话的 scoped models；未配置模型 scoping 时回退为注册表中已配置密钥的模型。**思考强度选项始终跟随分析模型的支持档位**（例如只支持 `high`/`max` 的模型只显示这两档）；若已存配置的 effort 不被所选模型支持，选择模型时会自动修正。

## 控制前缀

| 前缀 | 行为 |
|---|---|
| `/!! xxx` | 强制翻译（绕过启发式**和**总开关） |
| `/! xxx` | 强制跳过（剥离前缀后 pass through） |
| （无前缀） | 启发式决定（启用时） |

启发式规则：输入含模糊动词（`弄/搞/整/修一下/加个/...`）或短于 ~15 字且无具体目标（文件路径、函数名等）时进入翻译；较长的、带具体目标的输入原样通过。**对话控制指令**（确认/继续/开始/同意/OK/continue 等）一律直接通过——它们是在确认或指挥，不是模糊需求。

## 思考强度安全网

推理模型在低档位下可能返回空内容（例如 `deepseek-v4-flash` 在 `off` 档输出为空）。分析器会：

- 配置的 effort 不被分析模型支持时，按优先级兜底（`high` > `max` > … > `off`）
- 模型返回空响应时，自动高一档重试一次

## 安装

### 开发模式（本仓库，推荐）

仓库入口符号链接到 pi 的自动发现目录：

```bash
ls -la ~/.pi/agent/extensions/translator.ts
# -> <本仓库>/extensions/translator.ts (符号链接)
```

编辑 `extensions/translator.ts` 后在 pi 里 `/reload`。

### 独立安装

```bash
pi install git:github.com/TimYuann/Talk-like-a-pro
```

## 项目结构

```
Talk-like-a-pro/
├── extensions/
│   └── translator.ts   # 唯一源文件
├── package.json        # pi-package 清单
├── README.md           # 英文版
├── README.zh-CN.md     # 中文版
├── CHANGELOG.md        # release notes
├── CONTRIBUTING.md     # 开发规范（commit / 发布流程）
├── LICENSE             # MIT
└── .gitignore
```

## 已知限制

- `ctx.ui.select` 不渲染选项描述；prompt 已要求 LLM 让选项 label 自包含
- 多轮问答没有"全部跳过"按钮——每个问题只能单独回答或取消
- 问答后总是触发第二次 LLM 调用（二次合成）；大模型上可能较慢
- 设置界面需要 TUI 模式；非 TUI 模式用命令参数
- 分析模型候选来自当前会话的 scoped models；某会话配置的模型在别的会话可能不可用（回退到当前模型）

## 调优

分析 prompt 与 refined-prompt 模板都在 `extensions/translator.ts`：

- `buildAnalyzerPrompt(context, userInput, previousAnswers, level)` — 组装 prompt；各层级行为在 `LEVEL_PROMPT_BLOCKS`（1 入门 / 2 标准）
- `parseAnalysis()` — JSON 解析器；容忍 markdown fence 和周围杂文
- `callAnalyzer()` / `safeAnalyze()` — LLM 调用 + 空输出重试 + 解析失败重试 + 错误兜底
- `resolveAnalyzerModel()` / `supportedEfforts()` — 分析模型解析与按模型的 effort 过滤
- `pickFallbackEffort()` — effort 不支持时的兜底优先级

要改默认配置（总开关、层级、模型、effort），编辑 `DEFAULT_CONFIG`。
