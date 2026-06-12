# M12 开发任务项

> 来源文档：`docs/m12-progress-evaluation.md`
> 生成日期：2026-06-12
> 目标：把 M12 进展评估中的缺口转成可执行、可验收、可测试的开发任务。

---

## 执行顺序

建议按以下顺序推进：

1. `M12-T0` 先建立当前基线，避免后续改动无法判断回归来源。
2. `M12-T1` 优先修复 `next_pipeline` 死代码，这是 M12 编排主循环的核心缺口。
3. `M12-T2` 打通预算配置链路，移除硬编码 `1`。
4. `M12-T3` 补全终态 `run_state` 里的预算和计数器写入。
5. `M12-T4` 补集成 fixture，证明 fail -> fix -> pass 可从 CLI 链路跑通。
6. `M12-T5` 只做技术评估和最小重构边界确认，外层 batch/全局编排可延后到 M14/M15。

---

## M12-T0：建立当前 M12 基线

**优先级**：P0
**类型**：测试/基线
**依赖**：无
**涉及文件**：

- `tests/core/orchestrator.test.ts`
- `tests/core/decision-engine.test.ts`
- `tests/reporting/finalizer.test.ts`
- `tests/cli/program.test.ts`
- `package.json`

**任务说明**：

在修改编排逻辑前，先确认现有测试状态，并记录与 M12 相关的测试入口。该任务不改业务逻辑，只用于固定后续验收基线。

**执行项**：

- [x] 运行 `npm test -- tests/core/orchestrator.test.ts tests/core/decision-engine.test.ts`。
- [x] 运行 `npm test -- tests/reporting/finalizer.test.ts`。
- [x] 运行 `npm run typecheck`。
- [x] 若存在与 M12 无关的既有失败，在后续 PR/提交说明中单独标记为 baseline failure。

**完成标准**：

- [x] 当前 M12 相关测试能被单独运行。
- [x] 后续任务可以用同一组命令判断是否引入回归。

---

## M12-T1：让 Orchestrator 消费 `unit_decision.next_pipeline`

**优先级**：P1
**类型**：核心功能
**依赖**：`M12-T0`
**对应评估缺口**：R2、R3
**涉及文件**：

- `src/core/orchestrator.ts`
- `src/core/decision-engine.ts`
- `src/evaluator/evaluator-pipeline.ts`
- `tests/core/orchestrator.test.ts`
- `tests/core/decision-engine.test.ts`

**任务说明**：

当前 `DecisionEngine` 已在 `next_pipeline` 中产出结构化路由信息，但 `Orchestrator` 只读取 `decision` 字符串，并在内部重复实现分支逻辑。需要改为由 `next_pipeline` 驱动下一阶段调度。

**执行项**：

- [x] 为 `next_pipeline` 定义明确类型，至少覆盖：
  - `null`
  - `{ module: 'evaluator', mode: 're_evaluate', attempt: number }`
  - `{ module: 'generator', mode: 'fix', fix_round: number, target_failures: string[] }`
- [x] 在 `Orchestrator.runUnit()` 中保留 `pass`/`stop` 作为终态分支，但非终态分支必须读取 `decision.next_pipeline`。
- [x] `re_evaluate` 路径使用 `next_pipeline.attempt` 设置 evaluator attempt，而不是只做本地 `attempt += 1`。
- [x] `fix` 路径使用 `next_pipeline.fix_round` 设置 fix round，并用 `next_pipeline.target_failures` 与 evaluator failures 对齐后传给 generator。
- [x] 当 `decision` 与 `next_pipeline` 不一致时，抛出带明确 code 的 `OrchestratorError`，例如 `AGENTFLOW_ORCHESTRATOR_INVALID_NEXT_PIPELINE`。
- [x] 删除或收敛 Orchestrator 内部重复路由逻辑，确保新增决策类型时只需更新 `DecisionEngine` 和路由类型。

**完成标准**：

- [x] Orchestrator 的下一步动作由 `unit_decision.next_pipeline.module` 和 `mode` 决定。
- [x] `DecisionEngine.next_pipeline` 不再是运行时死数据。
- [x] `re_evaluate` 仍只重新调用 evaluator，不重新调用 generator。
- [x] `fix` 仍重新调用 generator，并把 evaluator failures 正确传入 `previousFailures`。
- [x] 非终态决策缺少合法 `next_pipeline` 时不会静默继续。

**建议测试**：

- [x] 更新 `tests/core/orchestrator.test.ts`：断言 fix 和 re_evaluate 调度读取 `next_pipeline` 的 attempt/fix_round。
- [x] 增加 invalid `next_pipeline` 测试：非终态决策但 `next_pipeline: null` 时抛出 `OrchestratorError`。
- [x] 运行 `npm test -- tests/core/orchestrator.test.ts tests/core/decision-engine.test.ts`。

---

## M12-T2：打通预算配置链路，移除硬编码预算 `1`

**优先级**：P2
**类型**：配置/CLI
**依赖**：`M12-T1`
**对应评估缺口**：R6、R7
**涉及文件**：

- `src/config/config-loader.ts`
- `src/cli/commands/run.ts`
- `src/planner/planner-pipeline.ts`
- `src/core/orchestrator.ts`
- `src/evaluator/evaluator-pipeline.ts`
- `schemas/llm/llm.planner_package.schema.json`
- `tests/config/config-loader.test.ts`
- `tests/cli/program.test.ts`
- `tests/core/orchestrator.test.ts`
- `tests/evaluator/evaluator-pipeline.test.ts`

**任务说明**：

`max_fix_rounds` 和 `max_evaluator_retries` 目前事实来源仍是硬编码 `1`。需要形成明确优先级：CLI 显式参数 > 配置文件 > planner 输出 > 默认值。

**执行项**：

- [x] 在 `AgentflowConfig` 中新增预算字段，建议结构：

```ts
budgets: {
  maxFixRounds: number;
  maxEvaluatorRetries: number;
}
```

- [x] 在配置解析中支持 snake_case 和 camelCase：
  - `budgets.max_fix_rounds`
  - `budgets.maxFixRounds`
  - `budgets.max_evaluator_retries`
  - `budgets.maxEvaluatorRetries`
- [x] 为 `agentflow run` 增加 CLI 参数：
  - `--max-fix-rounds <n>`
  - `--max-evaluator-retries <n>`
- [x] 在 `run.ts` 中把 CLI/config 预算传给 `PlannerPipeline` 和 `Orchestrator`。
- [x] 在 `PlannerPipeline` 中移除 `MAX_FIX_ROUNDS = 1` 和 `MAX_EVALUATOR_RETRIES = 1` 作为唯一事实来源；默认值可以保留为 fallback 常量，但不能覆盖 CLI/config。
- [x] 让 planner package 的 `max_fix_rounds` 使用传入预算。
- [x] 调整 `schemas/llm/llm.planner_package.schema.json` 中 `max_fix_rounds.maximum: 1` 的限制，允许多轮修复。
- [x] 确保 `EvaluatorPipeline` 的默认预算与 Orchestrator 一致，不再分叉成另一套默认值。

**完成标准**：

- [x] 不传参时维持当前兼容行为。
- [x] 配置文件中设置预算时，planner package、unit decision、run_state 都使用配置值。
- [x] CLI 参数能覆盖配置文件。
- [x] `max_fix_rounds > 1` 能通过 schema 校验。
- [x] 预算值非法时给出明确错误，而不是被静默改回 `1`。

**建议测试**：

- [x] 新增/更新 `tests/config/config-loader.test.ts` 覆盖预算字段解析。
- [x] 更新 `tests/cli/program.test.ts` 覆盖新增 CLI option。
- [x] 更新 planner/evaluator/orchestrator 相关测试，覆盖 `max_fix_rounds: 2` 和 `max_evaluator_retries: 2`。
- [x] 运行 `npm test -- tests/config tests/cli/program.test.ts tests/core tests/evaluator`。
- [x] 运行 `npm run typecheck`。

---

## M12-T3：补全预算与计数器写入

**优先级**：P3
**类型**：可观测性/状态
**依赖**：`M12-T2`
**对应评估缺口**：R8
**涉及文件**：

- `src/core/orchestrator.ts`
- `src/reporting/finalizer.ts`
- `src/planner/planner-pipeline.ts`
- `src/adapters/process-runner.ts`
- `src/adapters/adapter-manager.ts`
- `src/schemas/validator.ts`
- `tests/reporting/finalizer.test.ts`
- `tests/cli/tool-commands.test.ts`
- `tests/core/orchestrator.test.ts`

**任务说明**：

终态 `run_state.counters` 中 `cli_processes_started` 和 `schema_failures` 始终为 `0`，预算也在 Finalizer 中写死为 `1`。需要把运行时真实值传到 Finalizer，并补齐计数来源。

**执行项**：

- [x] 在 Orchestrator 或独立运行指标对象中维护以下计数：
  - `fix_loops`
  - `commits_created`
  - `cli_processes_started`
  - `schema_failures`
- [x] 将 OrchestratorResult 扩展为携带完整 counters 和 budgets。
- [x] 在 `FinalizerInput` 中接收运行时 budgets/counters，替代当前硬编码值。
- [x] `Finalizer.writeFinalReport()` 和 `writeDecisionStopReport()` 写入同一套真实 budgets/counters。
- [x] 在实际启动 provider/CLI 子进程的位置累加 `cli_processes_started`。
- [x] 在 schema 校验失败被捕获或转换为 pipeline error 的位置累加 `schema_failures`。
- [x] 保留兼容 fallback：缺少新 counters 时不破坏 resume/finalize。

**完成标准**：

- [x] `run_state.budgets.max_fix_rounds` 和 `max_evaluator_retries` 等于本次运行实际预算。
- [x] `run_state.counters.fix_loops` 支持大于 `1`，不再只能得到 `0` 或 `1`。
- [x] 有 provider/CLI 子进程执行时，`cli_processes_started` 大于 `0`。
- [x] schema 失败能反映到 `schema_failures`，至少在可控测试场景中能断言。
- [x] pass 和 stop 两种终态写出的计数器字段一致。

**建议测试**：

- [x] 更新 `tests/reporting/finalizer.test.ts`，断言 Finalizer 写入传入 budgets/counters。
- [x] 更新 `tests/core/orchestrator.test.ts`，覆盖多轮 fix 计数。
- [x] 增加一个 schema failure 可控单测，断言计数递增或错误路径携带计数。
- [x] 运行 `npm test -- tests/core/orchestrator.test.ts tests/reporting/finalizer.test.ts`。

---

## M12-T4：补 CLI 级 fail -> fix -> pass 端到端 fixture

**优先级**：P4
**类型**：集成测试
**依赖**：`M12-T1`、`M12-T2`、`M12-T3`
**对应评估缺口**：R11 的 E2E 缺口
**涉及文件**：

- `tests/cli/*`
- `fixtures/*`
- `src/cli/commands/run.ts`
- `tests/core/orchestrator.test.ts`

**任务说明**：

当前已有核心单测验证 fail -> fix -> pass，但缺少从 `agentflow run` 入口触发的端到端 fixture。需要新增一个可重复的 mock provider 场景，证明 CLI 会自动走完整循环并最终 finalize。

**执行项**：

- [x] 新增最小 fixture 仓库或测试内临时仓库，首轮 evaluator 返回 fixable failure。
- [x] 配置 mock generator 在 fix 模式下产出修复后的 change package。
- [x] 配置 mock evaluator 在修复后返回 pass。
- [x] 通过 `agentflow run --repo <repo> --task <task>` 或直接调用注册后的 commander action 运行。
- [x] 断言输出 JSON 中：
  - `status` 为 finalized。
  - `unit.decision` 为 pass。
  - `unit.fix_rounds` 为 1 或配置指定值。
  - `outputs.final_or_stop_report` 指向 final report。
- [x] 断言 `.agentflow/run.json` 中 counters 与 budgets 正确。

**完成标准**：

- [x] CLI 集成测试能稳定跑过 fail -> fix -> pass。
- [x] 测试不依赖真实外部 LLM 或网络。
- [x] 失败时能从断言中看出停在 generator、evaluator、decision 还是 finalizer。

**建议测试**：

- [x] 运行新增 CLI 集成测试。
- [x] 运行 `npm test -- tests/core/orchestrator.test.ts tests/cli`。
- [x] 运行 `npm run typecheck`。

---

## M12-T5：评估外层管道编排化边界

**优先级**：P5
**类型**：设计/小步重构
**依赖**：`M12-T1`
**对应评估缺口**：R3、后续 M14/M15
**涉及文件**：

- `src/cli/commands/run.ts`
- `src/core/orchestrator.ts`
- `docs/roadmap.md`
- 后续可能新增 `src/core/run-orchestrator.ts` 或 `src/core/batch-runner.ts`

**任务说明**：

评估报告指出 `run.ts` 外层仍是 `ContextBuilder -> PlannerPipeline -> Orchestrator -> Finalizer` 手写顺序代码。该缺口范围较大，和 M14/M15 的 RouterRunner、BatchRunner 强相关。本任务只要求明确边界并做最小可回滚整理，不强行一次性实现完整 batch 编排。本轮已抽出薄的 `RunOrchestrator`，仅封装单 run 调用链，后续 M15 可由 `BatchRunner` 调度它来执行单个 unit。

**执行项**：

- [x] 梳理 `run.ts` 中哪些步骤属于单 run 编排，哪些属于 CLI 展示/错误格式化。
- [x] 若有明显收益，抽出一个薄的 `RunOrchestrator`，封装 context/planner/unit/finalizer 调用链。
- [x] 保持 `registerRunCommand()` 只负责参数解析、输出 JSON、设置 exitCode。
- [x] 不在本任务中实现 batch 并行、unit 依赖调度或 worktree 隔离。
- [x] 在 `docs/roadmap.md` 或本文件中记录外层编排后续应接到 M15 `BatchRunner`。

**完成标准**：

- [x] `run.ts` 的职责边界更清晰，但行为不变。
- [x] M12 不被外层大重构拖慢。
- [x] 后续 M15 能以 `RunOrchestrator` 或 `BatchRunner` 接口继续演进。

**建议测试**：

- [x] 运行 `npm test -- tests/cli tests/core`。
- [x] 运行 `npm run typecheck`。

---

## 全局验收清单

完成以上任务后，M12 收尾应满足：

- [ ] Orchestrator 消费 `DecisionEngine.next_pipeline`，不再重复实现主要路由智能。
- [ ] `max_fix_rounds` 和 `max_evaluator_retries` 可由 CLI/config/planner 传入，默认值仅作为 fallback。
- [ ] planner schema 不再把 `max_fix_rounds` 限制为 `1`。
- [ ] Finalizer 写入真实 budgets/counters。
- [ ] `fix_loops`、`commits_created`、`cli_processes_started`、`schema_failures` 有明确数据来源。
- [ ] 预算超限仍产出 `stop_report`，且 reason_code 可追踪。
- [x] CLI 级 fail -> fix -> pass fixture 通过。

**推荐最终验证命令**：

```bash
npm run typecheck
npm test
```
