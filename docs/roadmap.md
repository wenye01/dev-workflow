# agentflow 实施路线图（可编排的 Planner / Generator / Evaluator 协作框架）

本文件记录从当前 MVP-0 到"可编排的多 agent 协作框架"还需补齐的工作，按里程碑组织。

设计思想来源：

- [Scaling Managed Agents: Decoupling the brain from the hands](https://www.anthropic.com/engineering/managed-agents)
- [Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps)

  —— 把"脑（Claude + harness）/ 手（sandbox + tools）/ 会话（事件日志）"解耦成稳定接口；sandbox 是可丢弃的 cattle；session 是 context 之外的持久对象。

  —— planner / generator / evaluator 三角色；GAN 式生成器↔评估器迭代；契约协商；上下文重置 + handoff 交接。

当前战术目标：先规划 **planner / generator / evaluator** 三个顶层角色，每个角色下挂的"具体 agent"由编排（路由 + 配置）动态决定。

长期方向：agentflow 应演进为一个可恢复、可观测、可并发的 Dynamic Workflow Runtime；Planner / Generator / Evaluator 是内置 recipe，而不是唯一编排模型。详见 [dynamic-workflow-direction.md](./dynamic-workflow-direction.md)。

---

## 现状基线（已完成）

| 能力 | 状态 | 主要文件 |
| --- | --- | --- |
| 工件/会话持久化（append-only 日志） | ✅ | `src/artifacts/*`，`schemas/*` |
| Project Index 构建 | ✅ | `src/project-index/*` |
| Context Builder（task / 项目上下文 / source slice / 角色输入） | ✅ | `src/context/context-builder.ts` |
| 适配器层（脑↔手解耦，provider 候选回退） | ✅ | `src/adapters/*`，`codeagent-wrapper/` |
| 角色目录（角色→provider 候选） | ✅ | `src/config/role-catalog.ts` |
| 决策引擎（pass/fix/re_evaluate/stop 规则） | ✅ | `src/core/decision-engine.ts` |
| Generator/Evaluator 真正调用 LLM + scope 审计 + 提交 + 验证命令 | ✅ | `src/generator/*`，`src/evaluator/*` |
| Finalizer / Resume（幂等报告补全） | ✅（部分） | `src/reporting/finalizer.ts` |

**核心缺失**：编排"大脑"和主循环——Planner 是硬编码桩、RouterRunner 未接线、`DecisionEngine.next_pipeline` 无人消费、无 batch 调度、无 worktree 隔离、无可续跑的 handoff。

---

## 里程碑总览与依赖顺序

```
M12 编排主循环 ──┬─> M14 动态路由(RouterRunner 接线)
                │
M13 真实 Planner ┘        M15 batch/依赖调度 ──> M16 worktree 隔离 ──> M17 可续跑 handoff
                                                                         │
                          M18 契约协商 ─────────────────────────────────┤
                          M19 评估器分级评分 ───────────────────────────┤
                          M20 预算/计数器 + CLI 编排开关 ────────────────┘
```

建议优先级：**M12 → M13 → M14**（让端到端迭代真正跑起来），随后 M15/M16/M17（规模化与可恢复性），最后 M18–M20（质量与可观测性）。

---

## M12 — 编排主循环（generator ↔ evaluator 迭代）

**对应思想**：harness-design 的 GAN 式迭代主循环。

**问题**：`src/cli/commands/run.ts` 仅顺序跑 context→planner→generator→evaluator→finalize 一遍，从不消费 `DecisionEngine` 返回的 `next_pipeline`；Generator 的 `mode:'fix'`/`previousFailures`、Evaluator 的 `attempt`/`re_evaluate` 是死代码。

**范围**：
- 新建编排器 `src/core/orchestrator.ts`，封装"运行一个 unit 至终态"的循环：
  - 读 `unit_decision.next_pipeline`，分发到 `GeneratorPipeline.build({ mode:'fix', previousFailures })` 或 `EvaluatorPipeline.build({ attempt: n+1 })`。
  - 受 `run_state.budgets`（`max_fix_rounds`、`max_evaluator_retries`）约束，超限即 stop。
- `run.ts` 改为调用 orchestrator，而非手写四段。
- 把当前 planner 写死的 `max_fix_rounds: 1` 改为来自配置/planner 输出。

**验收**：
- 构造一个首轮失败、第二轮修复通过的 fixture，`agentflow run` 能自动走 generate→evaluate(fail)→fix→evaluate(pass)→finalize。
- 超过预算时产出 `stop_report` 且 `run_state.counters.fix_loops` 正确累加。
- 新增 `tests/core/orchestrator.test.ts`。

---

## M13 — 真实 Planner（从硬编码桩 → LLM agent）

**对应思想**：harness-design planner（1–4 句话 → 完整 spec、拆 unit/batch）。

**问题**：`src/planner/planner-pipeline.ts` 把 `unitId` 写死为 `'auth-refresh'`，永远产出 1 unit/1 batch/1 contract，不调用 `AdapterManager`。

**范围**：
- 让 planner 通过 `AdapterManager.runRole('planner.initial', ...)` 真正生成 `planner_package`（schema 已存在 `agentflow.schema.llm.planner_package.v1`）。
- 校验 LLM 输出：units 引用唯一、batches 引用存在、每个 unit 至少一条 `must` 验证标准（复用 `SchemaRegistry.assertLlmPayload`）。
- 失败回退：LLM 不可用 / 输出非法时，保留现有确定性单 unit 作为 degraded 模式，并在 `run_state` 标注。
- 移除 `'auth-refresh'` 等魔法值。

**验收**：
- 给定一句话任务，planner 产出 ≥1 unit 的合法 `planner_package` 并通过 schema 校验。
- provider 不可用时进入 degraded 单 unit 模式而非崩溃。
- 更新/新增 `tests/planner/*`（含 mock provider）。

---

## M14 — 动态路由（接线 RouterRunner）

**对应思想**：managed-agents"脑决定把工作发往哪只手"；本项目目标"具体 agent 由编排决定"。

**问题**：`src/routers/router-runner.ts` 已实现 `route()/aggregate()`，但三个 pipeline 都手写死单一 `selected_roles`，从不调用它。

**范围**：
- 在 planner/generator/evaluator 中用 `RouterRunner.route()` 取代手写 `router_dispatch`，由路由（可配置为 LLM 或确定性策略）从 `role-catalog` 候选里选出本轮 `selected_roles`。
- `role_run_request` → 实际 `runRole` 执行 → `aggregate()` 收敛产物，形成"route → run → aggregate"闭环。
- 配置开关：`routing.mode = 'deterministic' | 'llm'`，默认 deterministic 保证可重放。

**验收**：
- 同一 unit 在配置不同候选时，能路由到不同 generator/evaluator 具体角色，无需改代码。
- `routing_decision` 工件如实反映被选中的角色与理由。
- `tests/routers/*` 覆盖 deterministic 与 llm（mock）两条路径。

---

## M15 — Batch / 依赖调度器

**对应思想**：harness-design 的工作分解；managed-agents 的 many hands。

**问题**：schema 有 `batch_schedule`、unit `dependencies`、`locks.file_scope`，planner 产出 batches，但无执行器遍历。

**范围**：
- 新建 `src/core/batch-runner.ts`：按 `batch_schedule` 顺序执行各 batch；batch 内按 `parallel` 与 `dependencies` 做拓扑排序。
- 文件锁：依据 unit `locks.file_scope` 防止并行 unit 写冲突；冲突则降级串行。
- 与 M12 orchestrator 组合：batch-runner 调度 unit，orchestrator 跑单 unit 至终态。
- 复用 M12 抽出的 `RunOrchestrator` 作为单 run/单 unit 执行边界；M15 只在外层增加 batch 遍历、依赖排序和冲突控制。

**验收**：
- 2+ unit、含依赖关系的 fixture 能按正确顺序执行；无依赖且 scope 不冲突的可并行。
- 任一 unit stop 时按策略中止后续依赖 unit 并写 `stop_report`。
- 新增 `tests/core/batch-runner.test.ts`。

---

## M16 — Git worktree 隔离（sandbox = cattle）

**对应思想**：managed-agents"sandbox 可随时 provision/丢弃，是 cattle 不是 pet"。

**问题**：`run_state.workspace_mode='git_worktree'`、`worktreePath()` 仅是路径字符串，无人执行 `git worktree add/remove`；Generator 直接在 `repoRoot` 提交。

**范围**：
- 新建 `src/core/workspace.ts`：run 启动时 `git worktree add <AGENTFLOW_WORKTREES_DIR>/<runId>`，generator/evaluator 在 worktree 内工作，结束/失败时清理。
- Generator 的 `gitStatus`/`commitGeneratorChanges` 改为基于 worktree 路径。
- 失败/中断的 worktree 视为可丢弃，resume 时按 handoff 重建（衔接 M17）。

**验收**：
- 一次 run 不污染用户主工作区；worktree 在 finalize/stop 后被清理或显式保留。
- 并行 unit（M15）各自拥有隔离工作区或受锁保护。
- 跨平台（含 Windows）worktree 路径处理有测试覆盖。

---

## M17 — 可续跑的上下文重置 + handoff 交接

**对应思想**：harness-design 上下文重置 + 结构化 handoff；managed-agents `wake(sessionId)` / `getEvents()`。

**问题**：`finalizer.resume()` 只能幂等补全报告（`cannot_resume_reason` 明示无法续跑 fix/re_evaluate）；无供新会话中途接管的 handoff 工件。

**范围**：
- 定义 `handoff` 工件 schema（下一步动作 + 必要状态指针：当前 unit/batch、fix_round、目标 failures、相关工件 refs）。
- 每个稳定状态转移点写 handoff；orchestrator 启动时若检测到 handoff 则从该点续跑（清空上下文、起新角色会话）。
- `resume` 命令从"仅补报告"升级为"按 handoff 真正续跑"。

**验收**：
- 在 generator 完成、evaluator 未跑时 kill 进程，`agentflow resume` 能从 evaluate 续跑至终态。
- 续跑不重复已完成且已提交的工作（幂等）。
- `tests/reporting/*` 增补中断/续跑用例。

---

## M18 — 契约协商（sprint contract）

**对应思想**：harness-design generator↔evaluator 动工前协商"done 的定义"。

**问题**：当前 planner 单方面产出一个 `acceptance_contract`，无协商回合。

**范围**：
- 在 generator 实施前增加一轮：generator 提议 contract（可测行为），evaluator 审阅，迭代至一致（受小预算约束）。
- 复用 `acceptance_contract` schema，新增协商轮次的工件记录。

**验收**：
- 协商产出的 contract 比 planner 原始 contract 更细化、可验证。
- 协商不收敛时降级到 planner 原始 contract 并标注。

---

## M19 — 评估器分级评分（怀疑性评审）

**对应思想**：harness-design 的分级评分标准 + few-shot 校准 + 怀疑性评审。

**问题**：`evaluator-pipeline.ts` 的 `evaluator_report` 主要由验证命令结果确定性拼装，LLM 仅判 `unsafe`；缺分级评分、阈值、反馈回 generator。

**范围**：
- 在 `evaluator_report` 中引入分级标准（如完整性/功能/质量）与硬阈值，任一低于阈值即 fail。
- 把评估批评作为 `previous_failures` 反馈给 generator 的 fix 轮（衔接 M12）。
- （可选）为前端/UI 类任务接入交互式验证（如 Playwright MCP）。

**验收**：
- 评估器能因"某标准低于阈值"判 fail 并给出可操作反馈，而非仅依赖命令退出码。
- fix 轮能消费上一轮评估批评。

---

## M20 — 预算/计数器生效 + CLI 编排开关

**对应思想**：harness 的可观测性与"质疑每个组件是否还 load-bearing"。

**问题**：`run_state.budgets/counters` 多为硬编码 0/1，无累加与熔断；`run` 命令缺编排开关，且未向 generator/evaluator 透传 `configPath`。

**范围**：
- 真实累加 `counters`（`cli_processes_started`、`commits_created`、`schema_failures`、`fix_loops`）并按 `budgets` 熔断。
- `run` 命令新增：`--config`、`--max-fix-rounds`、`--max-evaluator-retries`、`--routing-mode`、`--provider`、`--dry-run`；并把 `configPath` 透传到各 pipeline。
- 在 `final_report`/`stop_report` 的 `metrics` 中汇总真实计数。

**验收**：
- 命令行可调节修复轮数/路由模式并被运行时实际采用。
- 计数器与预算熔断有测试覆盖。

---

## 风险与注意事项

- **可重放性**：引入 LLM 路由（M14）与真实 planner（M13）后，需保留 deterministic 回退，确保测试与调试可复现。
- **跨平台**：worktree（M16）与 git/路径处理需覆盖 Windows（项目已有 `cross-platform.yml`）。
- **provider 依赖**：端到端真实运行依赖 `codeagent-wrapper` 二进制与外部 CLI 鉴权；单测继续用 mock adapter。
- **"质疑组件是否仍 load-bearing"**：随模型升级，部分 harness 组件（如固定的 fix 轮、上下文重置）可能变成冗余，路线图应定期回看精简。
