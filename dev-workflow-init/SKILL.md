---
name: dev-workflow-init
description: 初始化项目的 .dev-workflow/ 上下文目录。分析项目结构，生成分层上下文文件（must-inject / index-only / user-customizable）。
disable-model-invocation: true
allowed-tools:
  - Bash
  - Read
  - Glob
  - Grep
  - Write
  - Edit
  - AskUserQuestion
---

# 开发工作流初始化技能

你负责为项目初始化 `.dev-workflow/` 上下文目录。基于 Anthropic 的 Context Engineering 原则，将上下文分为三层：
构建时应该多使用subagent各自探索需要的内容，并创建文件。

1. **Must-inject**（始终注入到 agent prompt 中）：`.dev-workflow/docs/project.md`、`.dev-workflow/docs/commands.md`
2. **User-customizable**（用户自定义，同样注入）：`.dev-workflow/docs/custom/` 目录下的所有文件
3. **Index-only**（仅注入索引，agent 按需读取）：`.dev-workflow/docs/INDEX.md` → `.dev-workflow/docs/references/`

## 目标目录结构

```
project-root/                    # 项目根目录
├── .dev-workflow/               # 统一的工作流目录（本技能初始化）
│   ├── config.yml               # 工作流配置
│   └── docs/                    # 上下文文档目录
│       ├── project.md           # [Must-inject] 精简项目概览（~50行）
│       ├── commands.md          # [Must-inject] 构建/测试/检查命令（~30行）
│       ├── INDEX.md             # [Index-only] 参考文件目录
│       ├── custom/              # [Must-inject, 用户所有] 任意 .md 文件，全部注入
│       │   └── style.md         # （示例）编码风格 — 首次生成草稿，之后用户自维护
│       └── references/          # [Index-only] 详细参考文档，agent 按需读取
│           ├── architecture.md  # 架构详情，模块依赖，数据流
│           ├── dependencies.md  # 完整依赖清单，版本约束，用途说明
│           ├── test-patterns.md # 测试目录、命名、fixture、覆盖率
│           ├── api-contracts.md # 公开接口签名、请求/响应格式
│           └── config-reference.md  # 配置项、环境变量、默认值
└── src/ ...                     # 项目源代码

../worktree/                    # 工作流 worktree（项目根目录上一层）
└── {id}/                        # 单个 worktree
    ├── .dev-workflow/
    │   └── run/                 # [运行时] 工作流运行状态
    │       ├── state.json       # 工作流状态
    │       ├── tasks.json       # 任务定义
    │       ├── progress.json    # 执行进度
    │       ├── stage-history.json
    │       ├── review-result.json
    │       ├── test-result.json
    │       └── report.md
    └── ...                      # 项目源代码副本
```

## 步骤

### 1. 分析项目结构

检查项目以确定：
- 语言和框架（检查 pyproject.toml、package.json、Cargo.toml、go.mod 等）
- 构建系统（Makefile、tox.ini 等）
- 测试框架（pytest、jest、vitest、cargo test、go test 等）
- 代码检查/格式化工具（ruff、eslint、prettier 等）
- 项目目录结构（2层即可）

使用 Glob 和 Read 进行调查：
```
Glob: pyproject.toml, package.json, Cargo.toml, go.mod, Makefile, tox.ini, .eslintrc*, .prettierrc*
Glob: src/**/*, tests/**/*, lib/**/*
```

### 2. 生成 Tier 1 文件（Must-inject）

#### `docs/project.md`（精简，约50行以内）

```markdown
# {项目名称}

{一句话描述项目用途}

## 基本信息
- 语言：{语言} {版本}
- 框架：{主要框架}
- 关键依赖：{列出最重要的5个依赖}

## 目录结构
{两层级目录树}

## 架构概述
{1-2句话描述整体架构模式}
```

#### `docs/commands.md`（精确命令，约30行以内）

```markdown
# 项目命令

## 安装依赖
`{安装命令}`

## 运行测试
- 全部测试：`{命令}`
- 单个文件：`{命令}`

## 代码检查
- Lint：`{命令}`
- Format：`命令}`

## 构建
`{构建命令}`

## 本地运行
`{启动命令}`
```

### 3. 生成 Tier 3 文件（Index-only）

这些文件包含详细参考信息，不适合全部注入 context（占用过多 token），但 agent 在执行特定任务时可能需要查阅。
根据项目实际情况生成以下文件，**不需要的文件可以跳过**（不是每个项目都需要全部文件）。

#### `docs/references/architecture.md`（大多数项目需要）
- 模块/包依赖关系（用文字或简单图示描述）
- 核心数据流（数据从哪来到哪去）
- 关键设计决策和模式（如使用了什么架构模式）
- 入口点和主要调用链

#### `docs/references/dependencies.md`（大多数项目需要）
- 完整依赖清单及版本（从 lock 文件或配置文件提取）
- 每个关键依赖的用途（一句话）
- 开发依赖 vs 生产依赖的区分
- 已知版本约束或兼容性问题

#### `docs/references/test-patterns.md`（有测试的项目需要）
- 测试目录结构和组织方式
- 测试文件和函数的命名约定
- 常用 fixture / mock / helper 模式（附代码示例）
- 覆盖率要求和配置
- 测试数据/样本的存放位置

#### `docs/references/api-contracts.md`（有公开 API 的项目需要）
- 公开函数/类的签名和用途
- HTTP API 端点、请求/响应格式（如有）
- 数据模型定义
- 认证/鉴权方式


#### `docs/INDEX.md`
根据实际生成的 references 文件动态生成索引。示例：
```markdown
# Reference Index

以下文件包含详细参考信息，仅在任务相关时用工具读取。

- `references/architecture.md` — 架构详情，模块依赖图，数据流
- `references/dependencies.md` — 完整依赖清单，版本约束
- `references/test-patterns.md` — 测试约定，命名模式，fixture 设置
- `references/api-contracts.md` — 公开接口签名，请求/响应格式
```

**判断是否生成的规则**：
- 如果项目没有公开 API（如纯 CLI 工具），跳过 `api-contracts.md`
- 如果项目几乎没有配置，跳过 `config-reference.md`
- 如果项目没有测试，跳过 `test-patterns.md`（但在 INDEX.md 中注明"项目暂无测试"）
- `architecture.md` 和 `dependencies.md` 大多数项目都需要

### 4. 生成 Tier 2 文件（User-customizable）

检查 `.dev-workflow/docs/custom/` 目录：
- **如果 `custom/` 已存在且有文件**：不做任何修改，保留用户内容
- **如果 `custom/` 为空或不存在**：根据代码推断生成草稿 `custom/style.md`

`docs/custom/style.md` 草稿内容：
```markdown
# 编码风格

> 此文件由 init 自动生成草稿，请根据项目实际情况修改。
> custom/ 目录下的所有 .md 文件会自动注入到 agent 的上下文中。

## 命名约定
{从代码推断的命名模式}

## 导入排序
{推断的导入顺序}

## 错误处理
{推断的错误处理模式}

## 文件组织
{推断的文件组织方式}
```

### 5. 与用户确认

将所有生成的文件内容呈现给用户：
1. 先展示 `docs/project.md` 和 `docs/commands.md`（must-inject，需确认准确性）
2. 再展示 `docs/custom/style.md` 草稿（提醒用户这是草稿，请按需修改）
3. 最后展示 `docs/INDEX.md` 和 `docs/references/` 概要

询问用户：
- 命令是否正确
- 是否需要修改 `docs/custom/` 内容
- `docs/references/` 是否需要额外文件

### 6. 写入文件

将确认后的文件写入 `.dev-workflow/docs/`。

关键规则：
- **`docs/custom/` 目录中已存在的文件绝不覆盖**
- 如果 `.dev-workflow/docs/` 不存在则创建
- 如果已存在则只更新 `docs/project.md`、`docs/commands.md`、`docs/INDEX.md`、`docs/references/`

## 输出

报告已创建/更新的文件，及每个文件的简要内容摘要。
