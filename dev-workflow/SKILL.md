---
name: dev-workflow
description: 手动触发的多 Agent 协作开发工作流。用于 `/dev-workflow <需求>`：澄清需求、生成规格说明，并通过隔离 worktree 中的编排器执行实现、审查、测试和收尾。
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

# 开发工作流技能

你负责编排一个多Agent协作开发工作流。当用户调用 `/dev-workflow` 时，按以下步骤执行：

## 执行原则

- 这是手动触发技能，不需要根据普通对话自动触发。
- 优先保持用户当前项目不被意外修改：只在 `specs/<slug>/spec.md` 写入规格说明，然后由编排器创建隔离 worktree。
- 运行脚本时先定位本 skill 的根目录。如果当前工作目录不是 `dev-workflow/` skill 目录，使用该目录下的 `scripts/orchestrator.py` 的绝对路径。

## 第一步：收集需求

用户的输入即为其功能需求。如果输入为空或模糊，通过提问来澄清：

1. 用户想要的核心功能是什么？
2. 验收标准是什么（如何判断完成）？
3. 有哪些约束条件（技术栈、截止日期、范围边界）？

使用 AskUserQuestion 以交互方式收集这些信息；如果当前环境没有该工具，就用一条简短问题直接询问用户。

## 第二步：生成规格说明和 Slug

需求明确后，生成结构化的规格说明文档。参考本 skill 根目录下的 `templates/spec-prompt.md` 中的模板格式。

将规格说明写入项目的 `specs/` 目录，文件名使用 kebab-case 格式，例如 `specs/add-user-auth/spec.md`。

**同时确定一个简短的 kebab-case slug**（如 `add-user-auth`、`fix-login-bug`），用于标识本次工作流。slug 应从需求核心功能中提炼，简洁有意义。

规格说明应包含：
- **原始需求**：用户的原始需求文本
- **验收标准**：可衡量的成功标准
- **任务分解**：带ID的有序实现任务列表
- **约束条件**：技术和范围约束

## 第三步：启动编排器

规格说明写入完成后，启动 Python 编排器。将 `<slug>` 替换为第二步确定的 slug，`<spec_path>` 替换为实际的规格说明文件路径，`<skill_root>` 替换为本 skill 根目录：

```bash
python <skill_root>/scripts/orchestrator.py start --spec <spec_path> --slug <slug> --project <project_root>
```

## 第四步：报告状态

编排器启动后，报告：
- 工作流ID（来自stdout JSON输出）
- 工作树路径
- 当前状态

用户可以通过以下命令查看进度：
```bash
python <skill_root>/scripts/orchestrator.py status --project <project_root>
```

或恢复中断的工作流：
```bash
python <skill_root>/scripts/orchestrator.py resume --project <project_root>
```
