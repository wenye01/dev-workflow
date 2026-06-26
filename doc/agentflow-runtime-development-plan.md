# agentflow Runtime 开发计划

> 基于 `doc/agentflow-runtime-design.md`。
> 本文只描述开发阶段、开发点、关注事项、预期行为和模块关系，不描述时间排期。

## 1. 开发总目标

第一阶段目标不是做完整 Agent 平台，而是先把 runtime 做成一个小而可靠的事实机：

```text
Recipe owns control
  -> proposes Directive
  -> Policy admits or pauses
  -> Runtime normalizes Activation
  -> ContextBuilder builds input
  -> ActivationRunner calls AgentAdapter or RecipeRunner
  -> ArtifactStore persists outputs
  -> EventLog records facts
  -> StateProjector folds events and artifacts into RunState
  -> next tick continues
```

开发中必须始终守住以下边界：

- Recipe 才有编排权，普通 Agent 输出不能直接驱动下一步调度。
- Activation 是唯一执行边界，runtime 不能绕过 Activation 直接调用 Agent 或写输出。
- EventLog、ArtifactStore、ActivationStore 和 run.json 是恢复来源，内存状态只是缓存。
- Artifact 写入后，只有出现 `artifact.written` Event 才能进入 RunState。
- `@agentflow/adapter-cli` 是独立包边界，但只负责 CLI 调用协议、进程管理和后端输出归一化，不写 runtime 状态。
- MVP 先保持串行、单 writer、文件存储；并发 worker、远程队列、数据库事务、完整 workflow DSL 都不进入第一阶段核心。

## 2. 阶段 0：工程骨架与包边界

### 要做的事

- 建立 monorepo 基础结构：根 `package.json`、`pnpm-workspace.yaml`、`tsconfig.base.json`。
- 创建两个确认包：
  - `packages/runtime`
  - `packages/adapter-cli`
- 为两个包提供最小可编译入口。
- 明确公开导出：
  - `runtime` 暴露 contracts、public runtime API 和测试需要的最小 helper。
  - `adapter-cli` 暴露 protocol、backend、executor、parser、progress、error 相关 API。

### 关注点

- 不为了目录整洁拆包。只有稳定 API、独立消费者、独立测试价值、独立发布价值都成立时才拆包。
- `@agentflow/adapter-cli` 已确认是独立包，因为它可以围绕 request/result/progress/error 协议独立运行和测试。
- `runtime-fs`、`runtime-testkit`、`workflow-script`、`protocol/primitives` 仍是候选包，第一阶段不要提前拆。
- `adapter-cli` 不能依赖 runtime engine、store、StateProjector 等私有实现。

### 预期行为

- 两个 package 能独立 type-check。
- runtime 通过 `AgentAdapter` port 消费 adapter 结果。
- adapter-cli 不知道 EventLog、ArtifactStore、RecipeRunner、PolicyEngine 的内部结构。

### 周边关系

- 这是后续所有阶段的依赖边界。
- 如果这里把 adapter-cli 放回 runtime 内部，后续 backend parser、progress、session resume 会污染 runtime 事实机。

## 3. 阶段 1：Contracts 类型与 Schema

### 要做的事

- 在 `packages/runtime/src/contracts/` 实现核心契约：
  - `RunRecord`
  - `Activation`
  - `Capability`
  - `Artifact`
  - `Event`
  - `Recipe`
  - `Directive`
  - `Policy`
  - `RuntimeError`
  - ID、ref、schema id、content hash、cache key 相关类型。
- 实现 strict schema / type guard：
  - Event decoder
  - Directive schema
  - workflow_spec schema
  - human_decision schema
- 固定命名规则：
  - `ref` 是业务稳定引用。
  - `id` 是运行时实例标识。
  - `schema_id` 必须版本化。
  - `content_hash` 基于 canonical JSON 或 blob bytes。
  - 文件路径必须使用 escaped ref，不能直接拼接业务 ref。

### 关注点

- `contracts/` 只能包含纯契约，不依赖 engine、store、adapter、filesystem。
- Event decoder 必须拒绝未知事件和损坏 payload。
- schema failure 要返回结构化错误，不能靠字符串判断。
- 普通 Agent 即使输出 directive-like payload，也只能作为普通 Artifact 保存，不能解释为控制流。

### 预期行为

- 所有后续模块围绕同一套契约实现，不重复定义 payload。
- Directive、workflow_spec、human_decision 都能被严格校验。
- 未知 Event、缺字段 Event、损坏 JSONL payload 都能被明确拒绝。

### 周边关系

- StateProjector、ArtifactStore、ActivationRunner、PolicyEngine 都依赖本阶段类型。
- adapter-cli 不依赖 runtime 私有类型，但要在 wire schema 上与 artifact draft、usage、error 语义保持可映射。

## 4. 阶段 2：文件存储 MVP

### 要做的事

- 实现文件存储端口：
  - `FsRunStore`
  - `FsEventLog`
  - `FsArtifactStore`
  - `FsActivationStore`
  - `FsLock`
- 固定 run 目录结构：
  - `run.json`
  - `events.jsonl`
  - `artifacts/`
  - `activations/`
- 实现 safe ref escaping、atomic write、JSONL append。

### 关注点

- EventLog 是 append-only，`seq` 必须单调递增。
- Artifact 写入必须区分 temp write、rename、event append 三个事实阶段。
- Artifact 文件存在但没有 `artifact.written` Event 时，StateProjector fold 后不可见。
- MVP 是单 writer，不要在这一阶段实现分布式队列或多 worker claim。

### 预期行为

- seed artifact 写入后可以读回。
- JSONL seq 单调递增。
- 没有 Event 的 orphan artifact 不进入 RunState。
- atomic write 失败不会留下半写 JSON 作为有效事实。

### 周边关系

- ActivationRunner 后续必须通过 store 写 Artifact/Event，不能绕过。
- StateProjector 的恢复能力依赖本阶段的写入顺序和文件语义。
- 崩溃恢复测试会直接构造本阶段产生的中间状态。

## 5. 阶段 3：StateProjector 与 RunState

### 要做的事

- 实现 `StateProjector`：
  - Event fold
  - activation state reducer
  - activation cache_hit reducer
  - artifact loading
  - budget reducer
  - waiting reducer
  - phase/progress/wakeup projection
- 定义 `RunState`：
  - run status
  - activation 状态索引
  - visible artifacts
  - budget snapshot / remaining
  - waiting / human state
  - phase / progress projection
  - pipeline / barrier projection占位。

### 关注点

- StateProjector 是唯一状态 fold 入口。
- 不允许从 adapter 临时输出、日志、stderr 恢复业务状态。
- 缺失 artifact 或 activation spec 要报 runtime corruption，不要静默跳过。
- diagnostic artifact 默认不能当正常业务输入。

### 预期行为

- 清空内存后，仅凭文件存储恢复同一 RunState。
- orphan artifact fold 后不可见。
- `activation.cache_hit` 能投影出复用关系。
- phase/progress 可 replay，但不能替代业务 Artifact。

### 周边关系

- WorkflowEngine 的 tick 只能基于 RunState 决策。
- PolicyEngine、ContextBuilder、RecipeRunner 都读取投影后的状态。
- 后续恢复、预算、human、pipeline 都依赖本阶段的 reducer 纪律。

## 6. 阶段 4：Registry 与 Mock Adapter

### 要做的事

- 实现 registry：
  - `StaticAgentRegistry`
  - `StaticRecipeRegistry`
  - `InMemorySchemaRegistry`
- 实现 `MockAgentAdapter`。
- 定义 runtime 侧 `AgentAdapter` port 的最小输入输出契约。

### 关注点

- Registry 只解析定义，不做动态下载或安装。
- Mock adapter 用于 deterministic 测试，不承担真实 CLI 调用。
- Adapter 不能写 ArtifactStore 或 EventLog，只返回结构化 result / artifact draft。

### 预期行为

- mock adapter 能返回 `role_output` Artifact draft。
- schema registry 能校验 expected output。
- runtime 可以在不依赖真实 CLI 的情况下跑通单 Agent 测试。

### 周边关系

- 这是单 Agent tick 闭环的前置。
- 未来 `adapter-cli` binding 也要实现同一个 `AgentAdapter` port。

## 7. 阶段 5：单 Agent Tick 闭环

### 要做的事

- 实现：
  - `WorkflowEngine.start`
  - `WorkflowEngine.tick`
  - deterministic `RecipeRunner`
  - `DirectiveNormalizer`
  - `ActivationFactory`
  - `ActivationCache`
  - `ActivationRunner` agent path
  - serial `ActivationQueue`
- 跑通最小链路：
  - seed state
  - recipe 提出 agent activation
  - policy 放行
  - factory 生成 Activation
  - context builder 构造输入
  - mock adapter 返回 output
  - Artifact/Event 持久化
  - projector 恢复 state
  - recipe 标记 completed。

### 关注点

- Directive 去重用 `idempotency_key`。
- Activation 复用用 `cache_key`。
- 两者不能混用。
- cache hit 也必须写 EventLog，不能只靠内存判断。
- deterministic Recipe 不能依赖隐藏时间、随机数、外部网络或临时上下文。

### 预期行为

- 单 Agent run 能 completed。
- Event 顺序完整。
- 相同 `cache_key` 的 completed activation 不重跑 adapter，并记录 `activation.cache_hit`。
- 普通 Agent 输出 directive-like artifact 仍不会触发调度。

### 周边关系

- 这是第一条真正可运行闭环。
- 后续 Policy、Human、RecipeActivation、adapter-cli 都是在这个闭环上扩展，不应重写主路径。

## 8. 阶段 6：Policy 与 Budget

### 要做的事

- 实现：
  - `PolicyEngine`
  - directive source gate
  - activation approval gate
  - workflow limit gate
  - `BudgetTracker`
  - budget snapshot / remaining projection
- 将 policy 裁决接入 tick 调度边界。

### 关注点

- Policy 只在启动前裁决，不中途强杀 Agent。
- Budget exhausted 发生后，后续 activation 不启动；已经完成的结果保留。
- Capability 是轻量约束和提示，不是强 sandbox。
- approval gate 只负责进入 waiting，不直接执行用户选择。

### 预期行为

- 普通 Agent 产 directive 不会被执行。
- Recipe 能读取 remaining budget 并缩小 fan-out。
- budget exhausted 后写 `policy.stopped` / `run.stopped`，后续 activation 停止启动。
- approval required 时 run 进入 waiting。

### 周边关系

- HumanIntervention 依赖 approval waiting 状态。
- ContextBuilder 需要读取 Capability 和 budget hints。
- Recipe 可以根据 budget projection 改变下一步 Directive。

## 9. 阶段 7：HumanIntervention

### 要做的事

- 实现：
  - `human_request` Artifact
  - `human_decision` Artifact
  - `submitHumanDecision`
  - approval granted/rejected fold
  - waiting state resume
- 支持两类入口：
  - Capability approval
  - Recipe 主动 requestHuman。

### 关注点

- Human decision 是事实，不是直接动作。
- 用户批准后也是下一 tick 继续，而不是 submit 时立即执行 pending activation。
- reject / stop 语义要投影清楚，避免 pending activation 被误启动。
- human_request / human_decision 都必须进入 Artifact/Event 事实链。

### 预期行为

- approval required -> run waiting。
- approve -> 写 human_decision，下一 tick resume。
- reject / stop -> 不启动 pending activation，Recipe 可走替代分支或停止。
- 恢复后 waiting 状态可重建。

### 周边关系

- Policy approval gate 与 HumanIntervention 要严密衔接。
- StateProjector 是 waiting / resume 的事实来源。
- UI/CLI 未来只读取这些事实，不维护独立状态。

## 10. 阶段 8：RecipeActivation 与 interpreted_spec

### 要做的事

- 实现 recipe target execution path：
  - `target.kind='recipe'`
  - RecipeActivation 只能声明 directive 输出
  - directive Artifact strict validation
- 实现受限 `interpreted_spec` runner。
- 支持 RecipeActivation 产出 Directive 后由下一 tick 执行。

### 关注点

- RecipeActivation 不是普通 Agent。
- 只有 Recipe 或 RecipeActivation 产出的 Directive 能进入调度。
- workflow_spec 只能展开受限 Activation 图，不能引入完整 DSL 作者体验。
- deterministic Recipe 仍需可重放。

### 预期行为

- RecipeActivation 产 directive 后，下一 tick 可执行。
- workflow_spec 能展开有限图。
- schema 不通过时 activation failed，不污染 expected output。
- Agent 输出的 directive-like artifact 仍不会驱动调度。

### 周边关系

- 这是扩展编排能力的关键阶段。
- 不能让 interpreted_spec 变成完整 workflow DSL，否则会偏离第一阶段 runtime-only 边界。

## 11. 阶段 8.5：Pipeline / Barrier State

### 要做的事

- 实现 workflow state 投影：
  - parallel barrier group state
  - pipeline item / stage readiness
  - `phase.started`
  - `phase.completed`
  - `progress.logged`
- 让 Recipe 能基于 item-level readiness 推进 pipeline。

### 关注点

- `parallel()` 是 barrier，聚合前必须等待 group 完成。
- `pipeline()` 是逐 item 推进，item A ready 不应等待 item B。
- phase/progress 是可 replay runtime facts，但不能替代业务 Artifact。
- 不要为了 pipeline 引入完整 DSL。

### 预期行为

- parallel group 未全部完成前，不执行聚合分支。
- pipeline item A 可进入下一 stage 时，不等待 item B。
- phase/progress 可以投影给 CLI/UI。
- replay 后 pipeline/barrier 状态一致。

### 周边关系

- 依赖 Event/StateProjector 的稳定性。
- RecipeRunner 会读取这些投影决定下一批 Directive。

## 12. 阶段 9：`@agentflow/adapter-cli` Protocol

### 要做的事

- 在 `packages/adapter-cli` 实现协议层：
  - request schema
  - result schema
  - progress schema
  - adapter error schema
- 支持 process invocation：
  - `agentflow-adapter-cli run --request <request.json> --result <result.json>`
  - `agentflow-adapter-cli run --request - --result -`
- 实现基础 executor / parser：
  - timeout
  - cancel
  - command not found
  - invalid / truncated JSON
  - backend failed
  - no output
- 实现 runtime 侧 boundary mapper：
  - Activation + ContextPackage -> AdapterCliRequest
  - AdapterCliResult -> runtime artifact drafts / runtime error。

### 关注点

- adapter-cli 不写 EventLog。
- adapter-cli 不写 ArtifactStore。
- stderr/progress 不是业务输出。
- Runtime 不解析 Codex、Claude、Gemini 等 backend-specific stream。
- `session_id` 是 continuation handle，可以由 runtime 保存并在 resume request 回传。
- `progress_events` 是诊断 telemetry，只有 runtime 写成 `progress.logged` Event 后才成为 replay fact。

### 预期行为

- completed JSON result 经 runtime validate 后写 ProducedArtifact。
- truncated / invalid JSON 映射为 `INVALID_OUTPUT` 或 `PARSE_FAILED`。
- exit `124` -> `TIMEOUT`。
- exit `127` -> `COMMAND_NOT_FOUND`。
- exit `130` -> `CANCELLED`。
- progress 不写 EventLog 时，不影响 replay、cache、Recipe 分支。
- runtime 中没有 backend-specific parser。

### 周边关系

- adapter-cli 与 runtime 的唯一稳定关系是 request/result/error/progress 协议。
- backend fixture 和兼容性测试属于 adapter-cli。
- runtime contract tests 只验证 `AgentAdapter` port 行为。

## 13. 阶段 10：错误、恢复与幂等强化

### 要做的事

- 覆盖崩溃恢复场景：
  - Artifact temp file 写入前崩溃
  - Artifact 文件 rename 后、Event append 前崩溃
  - `activation.started` 后、adapter 返回前崩溃
  - `budget.charged` 前崩溃
  - `activation.completed` 后崩溃
  - `recipe.directive_recorded` 后崩溃
  - `activation.cache_hit` 后崩溃
  - EventLog 损坏
- 实现 stale running 标记。
- 实现 schema failure diagnostic artifact 策略。

### 关注点

- MVP 不自动重跑 stale running activation，只标记 failed。
- schema failure 不应让 expected output ref 变成可见业务 artifact。
- `idempotency_key` 用于重复 Directive，`cache_key` 用于输入等价执行复用。
- 任何恢复行为都必须追加 Event，而不是修改历史事实。

### 预期行为

- recovery 后状态可解释、可审计。
- orphan artifact 只产生 diagnostics，不进入业务状态。
- duplicate directive 不创建重复 activation。
- input artifact content_hash 变化后 cache_key 变化并重新执行。

### 周边关系

- 本阶段会反向检验 store、projector、activation cache 的设计是否正确。
- 如果恢复语义做不稳，不应继续推进并发 worker、远程队列或数据库存储。

## 14. 阶段 11：测试矩阵与质量门

### 必测场景

- 单 Agent run：Event 顺序完整，role_output 可读，run completed。
- Agent 产 directive：Artifact 可保存，但不会被执行为控制流。
- RecipeActivation 产 directive：schema 通过后下一 tick 可执行。
- ContextBuilder 裁剪：超 token 时按优先级裁剪或失败。
- approval required：run waiting，写 human_request。
- human approve：写 human_decision，下一 tick resume。
- human reject：pending activation skipped 或 recipe 替代分支。
- budget exhausted：后续 activation stop / reject。
- crash recovery：清空内存后 fold 可恢复状态。
- stale running：running activation 标记 failed stale。
- schema failure：activation failed，不污染 expected output。
- orphan artifact：没有 `artifact.written` 时 fold 不可见。
- event decoder：raw JSONL payload 只在事件层 decode。
- duplicate directive：`idempotency_key` 避免重复 activation。
- activation cache hit：`cache_key` 相同且输入 hash 未变时不重跑 adapter。
- changed input hash：Artifact `content_hash` 变化后 cache_key 变化并重新执行。
- deterministic recipe：deterministic mode 不依赖隐藏时间、随机数或外部网络。
- pipeline no barrier：单个 item 可独立进入下一 stage。
- parallel barrier：聚合前必须等待 group 完成。
- budget-aware recipe：Recipe 能读取 remaining budget 并减少 fan-out。
- phase/progress events：phase/progress 可 replay，不由日志推断。
- adapter-cli completed：adapter result validate 后才写 ProducedArtifact。
- adapter-cli invalid output：truncated / invalid JSON 映射为 adapter error，不解析 stderr 作为业务输出。
- adapter-cli timeout：exit `124` 映射为 `TIMEOUT`。
- adapter-cli command missing：exit `127` 映射为 `COMMAND_NOT_FOUND`。
- adapter-cli resume：Runtime 传入 `session_id`，adapter result 回传 continuation handle。
- adapter-cli progress：未转换成 `progress.logged` Event 的 telemetry 不进入 replay state。

### 关注点

- runtime 测 runtime facts，adapter-cli 测 CLI 协议和 backend fixture。
- 不要用日志断言业务状态。
- 不要让 mock adapter 掩盖真实 adapter protocol 的错误语义。
- 每个阶段都要能独立验收，不能把所有正确性都推迟到大集成测试。

## 15. 防跑偏清单

开发中遇到设计选择时，优先问以下问题：

- 这个状态是否能从 EventLog、ArtifactStore、ActivationStore 和 run.json 重建？不能就不要作为业务状态。
- 这个输出是否经过 schema validate？没有就不能进入 RunState。
- 这个控制流是否来自 Recipe 或 RecipeActivation？不是就不能调度。
- 这个模块是否真的有独立消费者、独立测试、独立发布价值？没有就不要拆包。
- 这个 adapter 行为是否 backend-specific？是的话放在 `adapter-cli`，不要放进 runtime。
- 这个 progress 是否写入 runtime EventLog？没有就只能是诊断，不能参与 replay、cache、branch。
- 这个阶段是否已经能独立验收？不能就说明开发点切得太大。
- 这个实现是否需要完整 workflow DSL、UI、多租户、强 sandbox、分布式队列？如果需要，通常已经超出第一阶段边界。

