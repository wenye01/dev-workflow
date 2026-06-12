# M12（编排主循环）开发进展评估

> 评估日期：2026-06-12
> 评估方式：Dynamic workflow 自动扫描代码库 + 逐项深挖对照
> 涉及 agent：19 个 subagent，扫描 7 个维度，评估 11 项需求

---

## 总体进度：72%

M12（编排主循环）核心框架已基本成型。Orchestrator 类已实现并包含完整的生成-评估-修复循环，测试文件存在且覆盖主要场景。但存在三个关键缺口：(1) `DecisionEngine.next_pipeline` 字段是死代码，Orchestrator 未消费该字段而是重复实现了相同的路由逻辑；(2) `max_fix_rounds` 和 `max_evaluator_retries` 均硬编码为 1，无法通过配置或 CLI 覆盖；(3) `run.ts` 外层管道仍为手写顺序代码，未完全委托给 Orchestrator。计数器累加也存在不完整的问题（`cli_processes_started` 和 `schema_failures` 始终为 0）。

---

## 需求逐项状态

| # | 需求 | 状态 | 证据 | 缺口 |
|---|------|------|------|------|
| R1 | `src/core/orchestrator.ts` 文件存在 | ✅ 完成 | 文件存在，160行，导出 `Orchestrator` 类（含 `runUnit` 方法）、`OrchestratorError`、`OrchestratorOptions`、`OrchestratorResult`。核心循环为 `for(;;)` 无限循环，通过注入的 `GeneratorRunner` 和 `EvaluatorRunner` 调度管道。预算强制使用 `maxFixRounds` 和 `maxEvaluatorRetries`，带迭代上限保护。 | 无 |
| R2 | Orchestrator 消费 `unit_decision.next_pipeline` | ⚠️ 部分 | `DecisionEngine` 在 `decision-engine.ts` 中生成 `next_pipeline` 字段（含 module、mode、fix_round、target_failures 等结构化路由信息），但 Orchestrator 完全不读取 `next_pipeline`，而是用硬编码分支逻辑（基于 decision 字符串：`pass`/`stop`/`re_evaluate`/`fix`）实现等效路由。`next_pipeline` 在整个运行时中是死数据。 | `next_pipeline` 被生成但从未被消费。Orchestrator 应读取 `DecisionEngine` 输出的 `next_pipeline` 来确定下一阶段、模式和参数，而非在内部重新实现分支逻辑。 |
| R3 | `run.ts` 委托给 orchestrator（非手写顺序管道） | ⚠️ 部分 | `run.ts`(line 61) 将内部 generator-evaluator 循环委托给 `Orchestrator.runUnit()`。但外层管道骨架（run.ts lines 46-78）仍为手写顺序代码：`ContextBuilder→PlannerPipeline→Orchestrator→Finalizer`。Orchestrator 内部也未使用 `DecisionEngine.next_pipeline` 进行路由。 | (1) 外层管道仍为手写顺序代码。(2) Orchestrator 重复实现了 `DecisionEngine.next_pipeline` 已编码的路由智能。 |
| R4 | Generator `mode:'fix'`/`previousFailures` 已接入 | ✅ 完成 | `mode='fix'` 选择特定 artifact 路径，记录 `attempt`/`fix_round` 到 `unit_state`，生成特定 prompt。Orchestrator 传递 `evaluator.failures` 作为 `previousFailures`。测试覆盖确认修复循环中 failures 正确流转到 generator。 | 无 |
| R5 | Evaluator `attempt`/`re_evaluate` 已接入 | ✅ 完成 | `attempt` 参数默认 0，参数化所有 artifact 路径，`re_evaluate` 时递增，`fix` 时重置为 0。Orchestrator 正确处理 `re_evaluate` 决策：递增 attempt 继续循环而不重新生成。测试确认 `re_evaluate` 仅产生一次 generator 调用和两次 evaluator 调用。 | 无 |
| R6 | 预算约束（`max_fix_rounds`, `max_evaluator_retries`）已强制执行 | ⚠️ 部分 | `DecisionEngine` 正确执行预算检查：fix 预算超出返回 `fix_budget_exceeded`，evaluator 重试预算超出返回 `evaluator_retry_budget_exceeded`。Orchestrator 计算 `iterationCap` 保证终止。但值硬编码为 1（`planner-pipeline.ts` lines 20-21），无 CLI 标志或配置项可覆盖。Finalizer 写入硬编码 1 而非运行时值。LLM planner schema 限制 `max_fix_rounds` 最大为 1。 | (1) 无 CLI 标志或配置文件入口。(2) 硬编码常量为唯一数据源。(3) Finalizer 写入字面量 1。(4) LLM planner schema 限制。 |
| R7 | `max_fix_rounds` 来自配置/planner（非硬编码 1） | ⚠️ 部分 | Orchestrator 存在解析链 `options.maxFixRounds ?? options.planner.maxFixRounds`，但上游从未提供值，硬编码 1 始终生效。`config-loader.ts` 无预算字段，CLI 无标志，LLM planner schema 限制为最大 1。 | (1) `AgentflowConfig` 无预算字段。(2) 无 CLI 标志。(3) 硬编码常量为唯一数据源。(4) LLM planner schema 限制。 |
| R8 | 计数器（`fix_loops` 等）正确累加 | ⚠️ 部分 | Orchestrator 正确追踪 `fixRound`（每次 fix 决策递增）和 `commitsCreated`（每次有 `commitRef` 递增）。值通过 `run.ts` 流向 Finalizer 写入终端 `run_state`。但 `cli_processes_started` 和 `schema_failures` 始终为 0。计数器仅在终端状态计算一次，无运行中增量更新。 | (1) `cli_processes_started` 始终为 0。(2) `schema_failures` 始终为 0。(3) 无运行中增量计数器更新。(4) `fix_loops` 回退逻辑仅产生 0 或 1。 |
| R9 | 预算超出时产出 `stop_report` | ✅ 完成 | `DecisionEngine` 在预算超出时返回 `decision='stop'` 带正确 `reason_code`。Orchestrator 传播 stop 状态。`Finalizer.writeDecisionStopReport()` 写入 `stop_report` artifact。`run.ts` 错误路径回退也捕获 `OrchestratorError`（含迭代上限超出）写入 `stop_report`。决策引擎测试验证 `fix_budget_exceeded` reason_code。 | 无功能缺口。 |
| R10 | 测试文件 `tests/core/orchestrator.test.ts` 存在 | ✅ 完成 | 文件存在，197行，包含 5 个测试用例：即时通过、修复-通过流程、重新评估（无重新生成）、修复预算耗尽、即时停止。覆盖所有决策分支和预算耗尽场景。 | 无 |
| R11 | Fixture：fail→fix→pass 端到端流程可用 | ✅ 完成 | `orchestrator.test.ts` line 120 专用测试用例验证完整 `generate→evaluate(fail)→fix→evaluate(pass)→finalize` 循环。断言验证 `status`/`fixRounds`/`evaluatorAttempts`/`commitsCreated`/调用模式/失败传播均正确。 | 无集成/E2E 测试，但 fixture 和循环机制需求已满足。 |

**汇总**：✅ 完成 6 项 / ⚠️ 部分 5 项 / ❌ 未开始 0 项

---

## 已完成的关键实现

1. **Orchestrator 核心循环** — `src/core/orchestrator.ts` 包含完整 generate↔evaluate↔fix 迭代，带 iterationCap 终止保护
2. **Generator fix 模式端到端接入** — `previousFailures` 从 evaluator 正确传递到 generator 的 fix 轮
3. **Evaluator re_evaluate 机制** — attempt 递增和重置逻辑完整
4. **DecisionEngine 预算熔断** — `fix_budget_exceeded` / `evaluator_retry_budget_exceeded` 正确触发
5. **stop_report 产出** — 预算超出时含 reason_code 和分类信息
6. **测试覆盖** — `orchestrator.test.ts` 5 个用例覆盖所有决策分支
7. **fail→fix→pass fixture** — 端到端循环验证通过

---

## 未完成的关键缺口

| 缺口 | 严重性 | 说明 |
|------|--------|------|
| `next_pipeline` 死代码 | 🔴 高 | Orchestrator 不消费 `DecisionEngine.next_pipeline`，硬编码分支重复了路由智能；若新增决策类型只更新一方，将导致路由不一致 |
| 预算值硬编码为 1 | 🟡 中 | `MAX_FIX_ROUNDS=1`、`MAX_EVALUATOR_RETRIES=1`，无 CLI 标志、无配置文件入口、LLM planner schema 也限制最大为 1 |
| 外层管道手写顺序代码 | 🟡 中 | `run.ts` 的 `ContextBuilder→PlannerPipeline→Orchestrator→Finalizer` 仍为手写四段式 |
| 计数器不完整 | 🟢 低 | `cli_processes_started` 和 `schema_failures` 始终为 0；计数器仅在终端状态一次性计算，无运行中增量 |

---

## 下一步建议（优先级排序）

| 优先级 | 行动 | 预估工作量 | 衔接里程碑 |
|--------|------|-----------|-----------|
| P1 | 让 Orchestrator 消费 `next_pipeline` 替代硬编码分支——读取其 `module`/`mode`/`parameters` 驱动管道调度，消除重复实现 | 中 | M12 收尾 |
| P2 | 使预算值可配置：`--max-fix-rounds`/`--max-evaluator-retries` CLI 选项 + `AgentflowConfig` 字段 + 移除 LLM planner schema `maximum:1` 限制 | 小 | M12 收尾 → M20 |
| P3 | 补全计数器：实现 `cli_processes_started`/`schema_failures` 追踪，运行中增量更新 | 小 | M20 |
| P4 | 评估外层管道编排化（可推迟到 M14/M15 阶段） | 大 | M14/M15 |

---

## 风险点

- **[中等] `next_pipeline` 死代码风险** — Orchestrator 与 DecisionEngine 的路由逻辑是两套独立实现，维护时容易产生不一致
- **[低] 硬编码 `max_fix_rounds=1` 限制系统灵活性** — 复杂代码生成任务无法多轮修复（已在 M20 识别）
- **[低] 计数器不完整影响可观测性** — 无法通过 report 准确了解资源消耗和失败模式

---

## 相关文件索引

| 文件 | 角色 |
|------|------|
| `src/core/orchestrator.ts` | 编排主循环 |
| `src/core/decision-engine.ts` | 决策引擎（含 `next_pipeline` 生成） |
| `src/cli/commands/run.ts` | CLI run 命令入口 |
| `src/generator/generator-pipeline.ts` | Generator 管道（含 fix 模式） |
| `src/evaluator/evaluator-pipeline.ts` | Evaluator 管道（含 re_evaluate） |
| `src/planner/planner-pipeline.ts` | Planner 管道（含硬编码预算值） |
| `src/reporting/finalizer.ts` | 终态报告（stop_report / final_report） |
| `tests/core/orchestrator.test.ts` | Orchestrator 测试 |
| `docs/roadmap.md` | 完整路线图 |
