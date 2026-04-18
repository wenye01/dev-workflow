# dev-workflow

多Agent协作开发工作流编排器。通过状态机驱动的流水线编排隔离的AI Agent，自动完成从需求澄清、规格说明生成、代码实现、审查、测试到PR提交的完整开发生命周期。

## 工作原理

工作流包含6个阶段，每个阶段由独立Agent在隔离的git worktree中执行：

```
bootstrap → implement → review → whitebox_test → blackbox_test → finish
    ↓          ↑          ↓           ↓               ↓            ↓
  初始化      重试       重试        重试            重试         PR/报告
```

各阶段失败后可根据结果重试或回退到前一阶段（如review失败可回到implement），达到最大重试次数则标记为failed。

每个阶段都是可插拔的，实现统一的 `BaseStage` 接口。Agent仅接收所需的最小上下文，所有状态变更通过git commit记录。

## 技能

| 技能 | 路径 | 说明 |
|------|------|------|
| `/dev-workflow` | `dev-workflow/SKILL.md` | 主编排技能：收集需求、生成规格说明、启动编排器 |
| `/dev-workflow-init` | `dev-workflow-init/SKILL.md` | 为项目初始化 `.dev-workflow/` 上下文目录 |

## 环境要求

- Python 3.11+
- [Claude Code CLI](https://claude.com/code) 或兼容的Agent后端

## 安装

作为skill安装到.claude/skills下或者.codex/skills下即可

## 快速开始

### 1. 初始化项目上下文（可选）

```
/dev-workflow-init
```

分析项目结构，在 `.dev-workflow/docs/` 下生成三部分上下文文件（must-inject / index-only / user-customizable），可以自定义想要的内容进去。

### 2. 启动工作流

```
/dev-workflow <你的功能需求>
```

### 3. 查看进度

```bash
python dev-workflow/scripts/orchestrator.py status   # 查看状态
python dev-workflow/scripts/orchestrator.py resume   # 恢复中断的工作流
```

### 4. 单独运行某个阶段

```bash
python dev-workflow/scripts/stage_runner.py run <stage> --worktree <path> --spec <path>
python dev-workflow/scripts/stage_runner.py list      # 列出可用阶段
```

## 项目结构

```
dev-workflow/
├── SKILL.md                  # 技能入口
├── scripts/
│   ├── orchestrator.py       # 主编排器CLI
│   ├── stage_runner.py       # 独立阶段运行器
│   ├── config.py             # 配置加载（.workflow.yml）
│   ├── models.py             # 公共 pydantic 数据模型
│   └── engine.py             # 状态机引擎（transitions）
├── stages/
│   ├── base.py               # BaseStage 抽象接口
│   ├── bootstrap.py          # 工作树初始化、分支创建
│   ├── implement.py          # 逐任务实现
│   ├── review.py             # 代码审查与反馈
│   ├── whitebox_test.py      # 白盒测试
│   ├── blackbox_test.py      # 黑盒测试
│   └── finish.py             # PR提交、报告生成
├── agents/
│   ├── base.py               # AgentBackend 抽象接口
│   ├── claude.py             # Claude Code CLI 封装
│   └── codex.py              # Codex CLI 封装
├── context/
│   ├── builder.py            # 按阶段组装上下文
│   └── feedback.py           # 重试时的反馈注入
├── templates/                # 各阶段提示词模板
├── schemas/                  # 阶段输出的JSON Schema校验
└── tests/
    ├── unit/
    ├── integration/
    └── contract/
```

## 许可证

MIT
