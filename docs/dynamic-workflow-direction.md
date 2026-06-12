# agentflow 未来方向：Dynamic Workflow Runtime

> 生成日期：2026-06-12
> 适用范围：未来架构方向，不要求迁移当前实现

本文把 agentflow 的长期方向从"固定 Planner / Generator / Evaluator 三角色框架"上移一层：agentflow 应成为一个可恢复、可观测、可并发的 workflow runtime；Planner / Generator / Evaluator 是内置 recipe，而不是唯一编排模型。

---

## 设计来源

- [Scaling Managed Agents: Decoupling the brain from the hands](https://www.anthropic.com/engineering/managed-agents)
  - 稳定接口比固定 harness 更重要。
  - session、harness、sandbox/tools 应解耦。
  - session 是外部持久事件日志，不等同于模型上下文窗口。
  - sandbox 是可替换资源，失败后可重建。
- [Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps)
  - 长任务需要任务分解、结构化 handoff、上下文重置。
  - generator 与 evaluator 分离能形成更可靠的反馈循环。
  - contract、分级评分、怀疑性评审能把主观质量变成可评估标准。
- Claude Code dynamic workflow 思路
  - 确定性脚本控制流程。
  - agent 执行局部智能任务。
  - parallel / pipeline 提供并发编排。
  - cache + resume 使长流程可恢复、可复用。
  - budget 驱动工作深度。

核心结论：**确定性 runtime 控制流程，agent 执行局部智能任务。**

---

## 目标定位

agentflow 不应只是"更复杂的三角色 harness"，而应是一个 agent workflow operating system：

```text
User task
  ↓
Workflow selector / planner
  ↓
Workflow runtime
  ├─ session log / events / artifacts
  ├─ agent(prompt, opts)
  ├─ parallel(thunks)
  ├─ pipeline(items, ...stages)
  ├─ phase(title) / log(message)
  ├─ budget
  ├─ cache / resume
  └─ sandbox / worktree / tool execution
        ↓
  roles: planner / generator / evaluator / reviewer / critic / fixer ...
```

Planner / Generator / Evaluator 仍然重要，但它们应变成默认 workflow recipe：

```text
recipes/long-running-app-dev
  planner
    → contract negotiation
    → generator/evaluator loop
    → final critic
    → finalize
```

这样后续可以自然支持：

- `review-changes`
- `bug-hunt`
- `code-migration`
- `frontend-qa`
- `adversarial-verify`
- `judge-panel`
- `loop-until-dry`
- `/loop` 自驱轮询任务

---

## 核心接口

### agent()

`agent()` 是 runtime 调用具体智能执行者的唯一主入口。它应包装现有 `AdapterManager.runRole()`，并统一处理 schema、artifact、cache、events、budget、sandbox。

建议形态：

```ts
await agent('implement unit A', {
  role: 'generator.implementer',
  schema: 'agentflow.schema.llm.role_output.v1',
  phase: 'Generate',
  isolation: 'worktree',
  inputArtifacts: [...],
  outputArtifact: '.agentflow/units/unit-a/roles/output.json',
  model: undefined,
});
```

关键选项：

| 选项 | 作用 |
| --- | --- |
| `role` | 逻辑角色，由 router/config 映射到 provider |
| `schema` | 输出 schema，runtime 校验并返回 typed payload |
| `phase` | UI 与事件日志分组 |
| `isolation` | `none` / `worktree` / future sandbox |
| `inputArtifacts` | cache key 与 prompt 上下文来源 |
| `outputArtifact` | typed artifact 输出位置 |
| `model` | 可选模型覆盖，默认继承 provider 配置 |

### parallel()

`parallel()` 用于有 barrier 的并发。它应限制并发，而不是无界 `Promise.all`。

```ts
const results = await parallel(
  units.map((unit) => () => agent(`process ${unit.ref}`, { role: 'generator.implementer' })),
  { concurrency: min(16, cpuCores - 2) },
);
```

适用场景：

- 多 reviewer 投票
- 多 unit 独立处理后统一 dedupe
- 多角度 sweep 后统一排序

### pipeline()

`pipeline()` 用于无 barrier 的流水线。Item A 可以进入 stage 3 时，Item B 仍在 stage 1。

```ts
const results = await pipeline(
  units,
  (unit) => agent(`analyze ${unit.ref}`, { phase: 'Analyze' }),
  (analysis) => agent(`verify ${analysis.ref}`, { phase: 'Verify' }),
);
```

默认优先使用 `pipeline()`，只有需要跨 item 汇总时才使用 `parallel()` barrier。

### phase() / log()

`phase()` 和 `log()` 不只是 UI 功能，也应写入 session event log。

```ts
phase('Scan')
log('Scanning changed files across risk dimensions')
```

### budget

budget 不应只表示 fix/retry 次数，还应覆盖 token、agent 调用数、wall time、并发资源。

```ts
budget.totalTokens
budget.spentTokens()
budget.remainingTokens()
budget.agentCalls()
```

需要 `codeagent-wrapper` 或 provider adapter 标准化 usage 回传。

---

## Session / Event Log

Managed Agents 的关键启发是：session 是持久对象，不是模型上下文窗口。agentflow 应把 `.agentflow/events/*.jsonl` 升级成 runtime 的核心存储。

每个 workflow run 至少记录：

- `workflow.started`
- `phase.started`
- `agent.call.started`
- `agent.call.completed`
- `agent.call.failed`
- `artifact.written`
- `cache.hit`
- `cache.miss`
- `budget.updated`
- `workflow.completed`
- `workflow.stopped`

事件日志必须满足：

- append-only
- 可按 runId 查询
- 可从中恢复 workflow 状态
- 可重建 UI 进度
- 可用于调试 provider / sandbox / schema 失败

---

## Cache / Resume

Dynamic workflow 的价值不只是并发，而是可恢复和可复用。

每个 `agent()` 调用应生成稳定 call key：

```text
hash(
  workflow_script_hash,
  primitive_name,
  prompt,
  normalized_opts,
  input_artifact_hashes,
  schema_id
)
```

不要只用 `(prompt, opts)`，否则输入 artifact 变更时会误复用旧结果。

resume 行为：

1. 加载 workflow script/spec。
2. 读取 event log。
3. 对已完成且 call key 未变化的 `agent()` 返回缓存 payload。
4. 只重跑新增、修改、失败或输入变化的调用。
5. 从最近稳定 phase 继续写事件。

这比 handoff 更底层。handoff 仍然需要，但应建立在可恢复 event log 与 agent call cache 之上。

---

## Sandbox / Worktree

worktree 不应是 GeneratorPipeline 的特殊能力，而应是 `agent()` 的 isolation 选项。

```ts
await agent('edit files for unit A', {
  role: 'generator.implementer',
  isolation: 'worktree',
});
```

runtime 负责：

- provisioning：`git worktree add` 或 future sandbox 创建
- credential boundary：sandbox 不直接接触主控凭据
- cleanup：成功/失败后按策略清理或保留
- resume：根据 event log 和 handoff 重建可丢弃环境
- lock：按 file scope 防止并行写冲突

目标是实现 Managed Agents 中的"many brains, many hands"：brain/harness、session、hands/sandbox 可以独立失败、独立替换。

---

## Planner 的未来职责

Planner 不应直接成为不可预测的总控大脑。它的职责应是选择或生成受限 workflow spec。

建议 Planner 输出：

```json
{
  "recipe": "long-running-app-dev",
  "units": [],
  "quality_patterns": ["contract-negotiation", "skeptical-evaluator"],
  "parallelism": { "max_agents": 8 },
  "isolation": "worktree",
  "budgets": {
    "max_tokens": 500000,
    "max_fix_rounds": 3
  }
}
```

更进一步，可以允许 Planner 生成受限 workflow script，但必须经过静态校验：

- 禁止 `Date.now()` / `Math.random()` / 无参 `new Date()`
- 禁止动态 import
- 限制循环上限
- 限制 agent 总调用数
- 限制 parallel/pipeline item 数
- 所有 agent 输出必须绑定 schema
- 所有写操作必须绑定 isolation / scope

---

## Quality Pattern Library

质量模式应作为可组合 pattern，而不是硬编码在 EvaluatorPipeline 中。

建议内置：

| Pattern | 作用 |
| --- | --- |
| `adversarialVerify` | 多个独立质疑者验证发现，投票过滤误报 |
| `judgePanel` | 多方案评分，胜者融合亚军优点 |
| `loopUntilDry` | 持续发现直到连续 K 轮无新增 |
| `multiModalSweep` | 按容器、内容、实体、时间等角度并行搜索 |
| `completenessCritic` | 最终检查是否遗漏关键问题 |
| `contractNegotiation` | generator/evaluator 动工前协商 done 的定义 |
| `skepticalEvaluator` | 带分级评分和阈值的独立评估 |

示例：

```ts
phase('Sweep')
const findings = await parallel([
  () => agent('scan for correctness bugs', { schema: FINDINGS }),
  () => agent('scan for security bugs', { schema: FINDINGS }),
  () => agent('scan for regression risks', { schema: FINDINGS }),
]);

phase('Verify')
const verified = await adversarialVerify(findings.flat());

phase('Critic')
const gaps = await completenessCritic(verified);
```

---
  推荐路线图

  短期，做 WorkflowRuntime MVP：

  - agent()
  - phase()/log()
  - typed artifact output
  - event log
  - fixed concurrency parallel()
  - 把现有三角色流程搬成一个内置 recipe

  中期，做可恢复：

  - workflow run id
  - call cache
  - resume from event log
  - input artifact hashing
  - worktree isolation
  - budget accounting

  长期，做动态能力：

  - Planner 选择 recipe
  - Planner 生成受限 workflow spec
  - pattern library
  - /loop 自驱任务
  - 多 sandbox / 多 provider / 多 model 调度

  一句话方向

  不要把项目做成“更复杂的 Planner/Generator/Evaluator 框架”；要做成 agent workflow operating system：稳定 session、稳定 sandbox/tool 接
  口、稳定 workflow runtime，然后让三角色、QA、并发审查、长任务循环都跑在这个 runtime 上。

## 非目标

- 第一阶段不需要开放任意用户 JS 脚本执行。
- 第一阶段不需要完整 Claude Code workflow DSL 兼容。
- 不应把所有质量模式硬编码进 EvaluatorPipeline。
- 不应让 Planner 直接执行文件写入或 provider 调用。
- 不应依赖模型上下文窗口作为唯一 session 存储。

---

## 一句话原则

agentflow 的长期方向不是"更聪明的三角色 agent"，而是：

> 一个稳定、可恢复、可观测、可并发的 workflow runtime；三角色长任务开发只是运行在它上面的第一个 recipe。
