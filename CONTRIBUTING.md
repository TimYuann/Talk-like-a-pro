# Contributing / 开发规范

> 本文件是项目的工作规范（含给 agent 的规则），与用户文档（README）分开。

## 工作流：单人开发，直接 push

- 这是个人项目，**main 分支直接 commit + push**，不使用分支 / Pull Request
- 只有多人协作（外部贡献者）时才走 fork + PR；PR 合并用 squash，保持 main 历史线性
- 每轮开发 = 一次或多次 commit，每一轮结束按下方「发布流程」发 release

## Commit 规范（Conventional Commits）

格式：`type(scope): subject`

- **type**（与项目 ACTIVE_STATES 的 TYPE 对应）：
  | commit type | 含义 |
  |---|---|
  | `feat` | 新功能（对应 FEATURE） |
  | `fix` | 修 bug（对应 FIX） |
  | `refactor` | 重构，行为不变（对应 REFACTOR） |
  | `docs` | 文档（对应 DOCS） |
  | `chore` | 杂务：版本、发布、CI（对应 CHORE） |
  | `test` | 测试 |
  | `perf` | 性能 |
- **scope**（可选）：影响面，如 `settings`、`prompt`、`config`
- **subject**：小写开头、祈使句、≤72 字符
- 示例：`feat(settings): add analyzer model picker`、`fix: correct SelectList theme contract`

## 发布流程（每个版本）

1. 更新 `CHANGELOG.md`：把 `Unreleased` 内容归入新版本节（Keep a Changelog 格式）
2. bump `package.json` 的 `version`（semver；0.x 阶段 minor 允许 break）
3. commit（`chore: release vX.Y.Z` 或随最后一次改动一起）
4. `git tag vX.Y.Z`（tag 名 = release 名）
5. `git push` + `git push --tags`
6. GitHub Release 由 tag 生成（可补写 release note，内容 = CHANGELOG 对应节）

## 版本语义（当前 0.x 阶段）

- `0.1.0` 起：`patch` = bugfix，`minor` = 新功能（可 break），不升 `major`
- 达到稳定 API 后再定 `1.0.0`

## 开发环境（本地）

- 仓库 `extensions/translator.ts` 通过 symlink 挂到 `~/.pi/agent/extensions/`，改完 `/reload` 生效
- 语法烟囱测试：`bun build --target=node --external '@earendil-works/*' extensions/translator.ts --outfile=/tmp/check.js`
- 改动 prompt 模板时必须同步 README 的 Known limits / Tuning 节
- 内部记录（AGENTS.md / ACTIVE_STATES / *.bak-*）不入库，只留本地
