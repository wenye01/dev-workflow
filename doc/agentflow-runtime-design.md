# agentflow Runtime 详细设计方案

> 生成日期：2026-06-23
> 性质：runtime-only 设计方案。
> 来源：基于 `doc/agentflow-primitive-refinement-preview.md` 中的原语和 runtime 草案重组。
> 范围：只设计 monorepo 中 runtime 主包、内部模块、未来可抽离包、接口、存储、事件、恢复和测试切片。不展开标准 Agent、场景 Recipe、产品层架构或 UI。

---

## 1. Runtime 设计目标

Runtime 的核心职责是把六个原语跑起来，并保证运行过程可恢复、可审计、可测试。

本设计采用以下中心模型：

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

Runtime 不是一个强安全调度内核，也不是业务工作流框架本身。它只负责运行边界、状态事实、恢复机制和适配器调用。

### 1.1 设计原则

1. **Recipe 独占编排权**  
   普通 Agent 可以产出 plan、workflow_spec 或建议，但不能直接调度下一步。只有 Recipe 或 RecipeActivation 产出的 Directive 可以进入调度。

2. **Activation 是唯一执行边界**  
   Agent 和 Recipe 都必须通过 Activation 启动。Runtime 不直接调用 Agent，也不绕过 Activation 写输出。

3. **Event 是状态事实来源**  
   RunState 必须能从 `run.json`、`events.jsonl`、ArtifactStore 和 ActivationStore 重建。内存状态只是缓存。

4. **Artifact 是持久内容事实**  
   能影响后续 tick 的内容必须以 Artifact 形式写入，并通过 `artifact.written` Event 变为可见。

5. **Capability 保持轻量**  
   Capability 只影响启动前判断、上下文选择、预算提示和 adapter runtime hints。它不拦截 Agent 内部工具调用，不做文件/网络权限微内核。

6. **ContextBuilder 是输入构建核心**  
   Runtime 不把全部历史直接塞给 Agent。ContextBuilder 根据 ContextRequest、Capability 和当前 RunState 构建 ContextPackage。

7. **MVP 串行、单 writer、文件存储**  
   先实现一个可测试闭环。并发 worker、数据库事务和分布式队列是后续替换点，不进入 MVP 核心。

8. **确定性编排优先**  
   Recipe 的确定性部分应可重放。Runtime 不要求引入 JavaScript DSL，但应保留“确定性编排层 + Agent 智能执行层”的边界，让 cache/resume、预算感知和 pipeline 推进都建立在可验证的运行事实上。

### 1.2 明确非目标

Runtime 不负责：

- 设计标准 Agent 目录。
- 设计具体业务场景 Recipe。
- 设计完整 workflow DSL 作者体验。
- 设计 UI、服务端托管、多租户或 marketplace。
- Agent 内部工具调用、模型调用和文件读写策略。
- 强 sandbox、网络拦截、credential 管理。
- 在 Activation 运行中途强杀 Agent。
- MVP 阶段的多 worker 分布式调度。

### 1.3 Dynamic Workflow 思想输入

`doc/claude-code-dynamic-workflow.md` 对本设计的价值在于思想，而不是具体实现。agentflow 不直接照搬 Claude Code 的脚本 DSL、工具名或运行机制，但吸收以下 runtime 设计原则：

| 思想 | 对 agentflow runtime 的影响 |
| --- | --- |
| 确定性脚本控制流程，Agent 执行具体任务 | 保持 Recipe 编排权；deterministic Recipe 必须可重放，不依赖隐藏随机源或临时上下文 |
| schema-first 输出 | Adapter 输出先经 schema 校验，再进入 ArtifactStore；Runtime 不从自由文本解析控制流 |
| cache + resume | Activation 需要显式 cache key；输入 Artifact content hash 未变化时，已完成 Activation 不重跑 |
| pipeline 默认，barrier 按需 | Runtime 状态要能表达 item-level readiness；`parallel()` 是 barrier，`pipeline()` 是逐 item 推进 |
| 预算驱动自适应深度 | Recipe 应能读取 budget snapshot 和 remaining budget，在 Policy hard-stop 前主动收敛工作量 |
| phase/progress 可见 | phase/progress 是 EventLog 事实，不只是 UI 日志 |
| 自驱 wakeup | scheduled wakeup 可作为后续能力，由 `external.wakeup` 或 scheduled resume Event 表达，不进入 MVP 必需项 |

---

## 2. Monorepo 包组织原则

包不是目录边界。只有能独立使用、独立测试、独立发布、依赖边界稳定的模块才应该成为 package。否则它只是 `@agentflow/runtime` 内部模块。

当前仓库已有 `monorepo/` 目录，但尚无可见包结构。因此设计先固定两个明确 package 边界：

1. `@agentflow/runtime` 是核心 runtime 包，负责 EventLog、ArtifactStore、Activation、Recipe、Policy、State projection、Context、Budget、Human 和 runtime ports。
2. `@agentflow/adapter-cli` 是确认的独立包边界，负责外部 Agent CLI 的调用协议、进程管理、后端输出归一化、session resume、progress 诊断和 adapter 级错误语义。

这不是为了拆分而拆分。`adapter-cli` 能独立出来，是因为它的稳定性来自“调用输入 / 输出结果 / 错误码 / session / progress”的进程协议，而不是 runtime 内部状态。它可以用 fixture 和 contract tests 独立验证，也可以被 runtime 以外的 agent runner 复用。

### 2.1 MVP 包布局

```text
monorepo/
  package.json
  pnpm-workspace.yaml
  tsconfig.base.json
  packages/
    runtime/
      package.json
      src/
        contracts/
          activation.ts
          artifact.ts
          capability.ts
          event.ts
          policy.ts
          recipe.ts
          ids.ts
          schema.ts
          errors.ts
          index.ts
        engine/
        activation/
        recipe/
        workflow/
        context/
        policy/
        budget/
        human/
        state/
        registry/
        queue/
        ports/
        storage/
          fs/
        adapters/
          mock/
        testing/
        errors/
        index.ts
    adapter-cli/
      package.json
      src/
        protocol/
          request.ts
          result.ts
          errors.ts
          progress.ts
          index.ts
        backends/
          backend.ts
          codex.ts
          claude.ts
          gemini.ts
        executor/
          process-runner.ts
          timeout.ts
        parser/
          stream-parser.ts
          result-parser.ts
        progress/
          progress-emitter.ts
        errors/
          adapter-cli-error.ts
        index.ts
```

第一阶段确认的 package 边界：

| 包 | 职责 | 说明 |
| --- | --- | --- |
| `@agentflow/runtime` | Runtime contracts、engine、runner、state projector、filesystem MVP、mock adapter、test helpers | 核心事实机和调度器；不内置 CLI 后端解析逻辑 |
| `@agentflow/adapter-cli` | 外部 Agent CLI 的 invocation/result protocol、process execution、backend normalization、session/progress/error mapping | 确认独立边界；第一阶段可以先稳定协议和测试夹具，不要求完整实现所有 backend |

### 2.2 Package 抽离条件

除 `@agentflow/adapter-cli` 这个已确认边界外，内部模块只有满足以下条件时，才可以从 `@agentflow/runtime` 抽离成独立 package：

1. **稳定公共 API**：可以在不暴露 runtime 私有实现的情况下写出清晰接口文档。
2. **独立消费者**：至少有一个合理消费者不应该依赖完整 runtime。
3. **独立测试价值**：该模块有自己的 fixture、contract tests 或兼容性测试。
4. **独立发布价值**：版本变更节奏可能不同于 runtime 主包。
5. **依赖方向稳定**：不依赖 engine、runner、store 的私有类型。
6. **错误语义清晰**：错误码、输入校验和兼容性策略可以独立维护。

不满足这些条件时，拆包只会制造发布、版本和依赖噪音。

`@agentflow/adapter-cli` 已经满足这些条件：

- 它有清晰的进程级 request/result 协议。
- 它的直接消费者可以是 runtime，也可以是外部 agent runner。
- 它的测试重点是 CLI 后端兼容、stdout/stderr/event stream 解析、timeout/cancel 和 exit code，而不是 runtime replay。
- 它不能依赖 engine、EventLog、ArtifactStore 或 StateProjector 私有类型。
- 它拥有自己的错误码和兼容性策略。

### 2.3 候选未来包

这些包不是第一阶段默认拆分，只是未来满足抽离条件后的候选：

| 候选包 | 抽离触发条件 | MVP 状态 |
| --- | --- | --- |
| `@agentflow/protocol` 或 `@agentflow/primitives` | `runtime`、`adapter-cli` 和第三方工具都需要共享同一套 TS contracts，且不能让外部工具依赖完整 runtime | `runtime/src/contracts/` 内部模块；`adapter-cli` 先以 wire schema / boundary mapper 对齐 |
| `@agentflow/runtime-fs` | 文件存储需要被多个 runtime 变体复用，或数据库 store 与 fs store 要独立发布 | `src/storage/fs/` 内部模块 |
| `@agentflow/runtime-testkit` | 外部 recipe/adapter 包作者需要 mock adapter、memory store、replay assertions | `src/testing/` 内部模块 |
| `@agentflow/workflow-script` | 后续真的引入独立 workflow scripting runtime，并且它能脱离 engine 复用 | 暂不设计为包 |

### 2.4 第一阶段依赖方向

```text
@agentflow/runtime/contracts
  <- ports
  <- state / registry / context / policy / budget / human
  <- activation / recipe
  <- engine

@agentflow/runtime/ports
  <- storage/fs
  <- adapters/mock
  <- testing

@agentflow/runtime/ports/AgentAdapter
  <- @agentflow/adapter-cli runtime binding

@agentflow/adapter-cli/protocol
  <- backends / executor / parser / progress
```

依赖规则：

- `contracts/` 不依赖任何 runtime 执行模块。
- `engine/` 只通过 ports 调用 storage 和 adapters。
- `storage/fs/` 不能依赖 `engine/`、`activation-runner` 或 `recipe-runner`。
- `@agentflow/adapter-cli` 不能写 EventLog 或 ArtifactStore，只返回 adapter result。
- `@agentflow/adapter-cli` 不能依赖 runtime engine、runner、store、StateProjector 的私有类型。
- `@agentflow/runtime` 不能解析 backend-specific event stream，只能通过 `AgentAdapter` port 接收归一化结果。
- `testing/` 可以组装 memory store 和 mock adapter，但生产模块不能依赖 `testing/`。
- 未来抽包时，只能从已经稳定的内部边界向外抽，不重新切业务逻辑。

---

## 3. `@agentflow/runtime` 内部模块

```text
packages/runtime/src/
  contracts/
    activation.ts
    artifact.ts
    capability.ts
    event.ts
    policy.ts
    recipe.ts
    ids.ts
    schema.ts
    errors.ts
  engine/
    workflow-engine.ts
    tick.ts
    lifecycle.ts
  activation/
    activation-factory.ts
    activation-runner.ts
    capability-resolver.ts
    activation-cache.ts
  recipe/
    recipe-runner.ts
    interpreted-spec-runner.ts
    directive-normalizer.ts
    deterministic-guard.ts
  workflow/
    pipeline-state.ts
    barrier-state.ts
  context/
    context-builder.ts
    context-trimmer.ts
    event-summarizer.ts
  policy/
    policy-engine.ts
    directive-policy.ts
    activation-policy.ts
  budget/
    budget-tracker.ts
  human/
    human-intervention-manager.ts
  state/
    state-projector.ts
    event-decoder.ts
    reducers.ts
  registry/
    agent-registry.ts
    recipe-registry.ts
    schema-registry.ts
  queue/
    activation-queue.ts
  ports/
    stores.ts
    adapters.ts
    clock.ts
    id-generator.ts
    logger.ts
  storage/
    fs/
      fs-run-store.ts
      fs-event-log.ts
      fs-artifact-store.ts
      fs-activation-store.ts
      fs-lock.ts
  adapters/
    mock/
      mock-agent-adapter.ts
  testing/
    memory-stores.ts
    fixtures.ts
    replay-assertions.ts
  errors/
    runtime-error.ts
  index.ts
```

### 3.1 模块职责边界

| 模块 | 负责 | 不负责 |
| --- | --- | --- |
| `contracts` | 六原语记录、共享 ID、schema id、事件类型、错误类型、运行时公共契约 | 文件系统、执行、adapter、状态 fold |
| `WorkflowEngine` | start、tick、stop、submitHumanDecision、状态驱动 | 具体 Agent 执行细节 |
| `ActivationFactory` | 补齐 id、run_id、created_by、idempotency_key、cache_key、默认 capability | 执行 Activation |
| `ActivationCache` | 根据 cache_key 判断 completed activation 是否可复用 | 绕过 EventLog 修改状态 |
| `ActivationRunner` | 执行单个 Activation，调用 adapter 或 recipe target，落 Artifact/Event | 调度下一步 Directive |
| `RecipeRunner` | 运行 deterministic / interpreted_spec / recipe_activation recipe，约束 deterministic mode 可重放 | 普通 Agent 编排权 |
| `workflow` | 维护 pipeline item readiness 和 parallel barrier state | 用户层 DSL 语法设计 |
| `ContextBuilder` | 从 RunState 和 Artifact/Event 构建 ContextPackage | 创造业务事实 |
| `PolicyEngine` | 来源、预算、approval、workflow limit 裁决 | 替业务选择分支 |
| `BudgetTracker` | canStart 和 charge，用 Event 记账 | 中途打断 Agent |
| `HumanInterventionManager` | 创建 human_request，写 human_decision，维护 waiting state | 直接执行用户选择 |
| `StateProjector` | fold events + stores 得到 RunState | 从 adapter 临时输出恢复状态 |
| `Registry` | 解析 Agent、Recipe、Schema 定义 | 动态下载或安装包 |
| `ActivationQueue` | MVP 内存队列和串行 drain | 分布式 claim |
| `storage/fs` | 文件系统 MVP store 实现 | 业务调度 |
| `ports/adapters` | 定义 AgentAdapter 边界和 runtime 侧 mapper | 解析具体 CLI 后端输出 |
| `adapters/mock` | 测试和本地 deterministic adapter | 生产 CLI 进程调用 |
| `testing` | memory store、mock adapter、replay assertions | 生产依赖 |

### 3.2 `@agentflow/adapter-cli` 包边界

```text
packages/adapter-cli/src/
  protocol/
    request.ts
    result.ts
    errors.ts
    progress.ts
    index.ts
  backends/
    backend.ts
    codex.ts
    claude.ts
    gemini.ts
  executor/
    process-runner.ts
    timeout.ts
    cancellation.ts
  parser/
    stream-parser.ts
    result-parser.ts
  progress/
    progress-emitter.ts
  errors/
    adapter-cli-error.ts
  index.ts
```

| 模块 | 负责 | 不负责 |
| --- | --- | --- |
| `protocol` | request/result/progress/error 的 wire schema | Runtime Event/Artifact 持久化 |
| `backends` | 后端 CLI 命令、参数、session resume 差异 | Runtime policy 或 recipe 选择 |
| `executor` | 进程启动、stdin/file/arg 输入、timeout、cancel、exit code | 分布式队列 |
| `parser` | stdout/stderr/event stream 到 adapter result/progress 的归一化 | 将 progress 写成 runtime facts |
| `progress` | 可选诊断输出和结构化 telemetry | 业务分支条件 |
| `errors` | adapter 级错误码和兼容性策略 | RuntimeError 的最终投影 |

`@agentflow/adapter-cli` 可以提供 library API 和 CLI process API，但 process API 是规范化边界，因为它能被不同语言和不同 runner 复用。

---

## 4. 核心类型契约

MVP 核心类型先放在 `@agentflow/runtime/src/contracts/`。`@agentflow/adapter-cli` 通过稳定 wire schema 和 runtime boundary mapper 对齐，不依赖 runtime 私有执行类型。只有当多个外部 adapter、CLI 或可视化工具都需要在不依赖完整 runtime 的情况下复用同一套 TS contracts 时，才抽离为 `@agentflow/protocol` 或 `@agentflow/primitives`。无论是否抽包，都不能让消费者重新定义事件和 Artifact payload。

### 4.1 ID 和基础类型

```ts
export type RunId = string;
export type ActivationId = string;
export type ActivationCacheKey = string;
export type ArtifactRef = string;
export type SchemaId = string;
export type AgentRef = string;
export type RecipeRef = string;
export type EventSeq = number;

export interface Usage {
  tokens_input?: number;
  tokens_output?: number;
  tokens_total?: number;
  calls?: number;
  wall_time_ms?: number;
}

export interface RuntimeError {
  code: RuntimeErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export type RuntimeErrorCode =
  | 'AGENT_NOT_FOUND'
  | 'RECIPE_NOT_FOUND'
  | 'ARTIFACT_NOT_FOUND'
  | 'SCHEMA_NOT_FOUND'
  | 'SCHEMA_VALIDATION_FAILED'
  | 'DIRECTIVE_REJECTED'
  | 'BUDGET_EXHAUSTED'
  | 'APPROVAL_REJECTED'
  | 'CONTEXT_BUILD_FAILED'
  | 'ADAPTER_FAILED'
  | 'ADAPTER_TIMEOUT'
  | 'STORE_WRITE_FAILED'
  | 'EVENT_APPEND_FAILED'
  | 'RUNTIME_CORRUPTION'
  | 'STALE_RUNNING';
```

命名约定：

- `ref` 是业务稳定引用，例如 `planner/package`。
- `id` 是运行时唯一实例，例如 `act_01H...`。
- `schema_id` 必须版本化，例如 `agentflow.directive.v1`。
- `content_hash` 使用 canonical JSON 或 blob bytes 计算。
- 文件名使用 escaped ref，不允许直接把 ref 当路径拼接。

### 4.2 RunRecord

```ts
export interface RunRecord {
  id: RunId;
  recipe_ref: RecipeRef;
  recipe_version?: string;
  status: RunStatus;
  policy: Policy;
  created_at: string;
  updated_at: string;
  metadata?: Record<string, unknown>;
}

export type RunStatus =
  | 'created'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'stopped'
  | 'failed';
```

`run.json` 只缓存 run metadata 和最新 status。事实来源仍然是 EventLog。

### 4.3 Activation

```ts
export interface Activation {
  id: ActivationId;
  run_id: RunId;
  target: ActivationTarget;
  objective: ActivationObjective;
  context_request: ContextRequest;
  expected_outputs: ExpectedOutput[];
  capability?: Capability;
  parent_activation_id?: ActivationId;
  created_by: ActivationCreator;
  idempotency_key: string;
  cache_key: ActivationCacheKey;
  metadata?: ActivationMetadata;
}

export type ActivationTarget =
  | { kind: 'agent'; ref: AgentRef; version?: string }
  | { kind: 'recipe'; ref: RecipeRef; version?: string };

export interface ActivationObjective {
  title: string;
  instructions?: string;
  params?: Record<string, unknown>;
}

export interface ExpectedOutput {
  ref: ArtifactRef;
  kind: ArtifactKind;
  schema_id: SchemaId;
  required: boolean;
}

export interface ActivationCreator {
  kind: 'recipe' | 'recipe_activation' | 'system';
  ref?: string;
  activation_id?: ActivationId;
}

export interface ActivationMetadata {
  audit_context?: boolean;
  concurrency_group?: string;
  branch_id?: string;
  loop_id?: string;
  labels?: string[];
}
```

Activation 规则：

1. Recipe 返回的 draft 可以省略 `id`，由 ActivationFactory 补齐。
2. `run_id` 必须等于当前 run。
3. `created_by` 必须可追溯到当前 recipe 或 recipe activation。
4. `target.kind='recipe'` 的 Activation 只能声明 `directive` 输出。
5. `target.kind='agent'` 即使返回 directive payload，Runtime 也只按普通 Artifact 保存，不解释为控制流。
6. `idempotency_key` 用于同一 Directive 在重复 tick、崩溃恢复和重放时去重。
7. `cache_key` 用于输入语义未变化时复用已完成 Activation 结果。
8. `cache_key` 必须至少覆盖 target、version、objective、context_request、expected_outputs、capability 中影响 adapter 行为的字段，以及输入 Artifact 的 content_hash。
9. 如果同一 `cache_key` 已有 completed activation，WorkflowEngine 可以记录 cache hit 并跳过执行，但不能跳过 EventLog 事实记录。

### 4.4 Capability

```ts
export interface Capability {
  work_mode:
    | 'plan'
    | 'execute'
    | 'review'
    | 'aggregate'
    | 'summarize'
    | 'memory'
    | 'recipe';

  visible_inputs?: VisibleInputs;

  budget?: {
    max_tokens?: number;
    max_calls?: number;
    max_wall_time_ms?: number;
  };

  approval?: {
    required: boolean;
    reason?: string;
    prompt?: string;
  };

  runtime_hints?: {
    model?: string;
    output_format?: 'json' | 'markdown' | 'patch' | 'mixed';
    temperature?: number;
    timeout_ms?: number;
  };
}

export interface VisibleInputs {
  artifacts?: ArtifactRef[];
  include_recent_events?: boolean;
  include_project_index?: boolean;
  include_handoff?: boolean;
}
```

Capability 合并顺序：

```text
AgentDefinition.default_capability
  <- Recipe supplied capability
  <- Activation capability override
```

合并规则：

- 标量字段后者覆盖前者。
- `visible_inputs.artifacts` 默认取并集。
- Activation override 可以用空数组表达“只看显式 context_request”。
- `budget` 取更严格值。
- 任一层 `approval.required=true` 即需要确认。
- `runtime_hints` 后者覆盖前者。

### 4.5 Artifact

```ts
export interface Artifact<T = unknown> {
  ref: ArtifactRef;
  run_id: RunId;
  kind: ArtifactKind;
  schema_id: SchemaId;
  content_hash: string;
  producer_activation_id?: ActivationId;
  payload?: T;
  storage_uri?: string;
  views?: ArtifactViews;
  metadata?: Record<string, unknown>;
}

export interface ArtifactViews {
  markdown?: string;
  summary?: string;
  diff?: string;
}

export type ArtifactKind =
  | 'task'
  | 'project_index'
  | 'context_package'
  | 'plan'
  | 'workflow_spec'
  | 'directive'
  | 'planner_package'
  | 'contract'
  | 'role_output'
  | 'change_package'
  | 'verification_report'
  | 'critique'
  | 'verdict'
  | 'summary'
  | 'handoff'
  | 'human_request'
  | 'human_decision'
  | 'final_report'
  | 'diagnostic';
```

Artifact 写入规则：

1. ProducedArtifact 先通过 SchemaRegistry 校验。
2. payload canonicalize 后计算 content_hash。
3. 大 payload 写入 blob，Artifact 中保留 `storage_uri` 和 views。
4. ArtifactStore 原子写入。
5. EventLog 追加 `artifact.written`。
6. StateProjector 只把已有 `artifact.written` Event 的 Artifact 放入 RunState。

### 4.6 Event

```ts
export interface Event {
  seq: EventSeq;
  run_id: RunId;
  type: EventType;
  activation_id?: ActivationId;
  artifact_ref?: ArtifactRef;
  payload?: Record<string, unknown>;
  recorded_at: string;
}

export type EventType =
  | 'run.started'
  | 'run.completed'
  | 'run.stopped'
  | 'run.failed'
  | 'recipe.directive_recorded'
  | 'activation.requested'
  | 'activation.waiting_approval'
  | 'activation.queued'
  | 'activation.started'
  | 'activation.cache_hit'
  | 'activation.completed'
  | 'activation.failed'
  | 'activation.skipped'
  | 'artifact.written'
  | 'policy.rejected'
  | 'policy.stopped'
  | 'budget.charged'
  | 'approval.requested'
  | 'approval.granted'
  | 'approval.rejected'
  | 'human.responded'
  | 'external.wakeup'
  | 'progress.logged'
  | 'phase.started'
  | 'phase.completed';
```

事件层必须是单一契约所有者：

- Event type union、payload 类型、type guard、normalizer 都由 `contracts/` 和 `state/event-decoder.ts` 统一导出。未来如果抽离 `@agentflow/protocol`，这些定义整体迁移，不允许分散复制。
- Store reader 返回 `unknown` 后必须经过 EventDecoder。
- StateProjector 和命令行展示都消费 typed event，不允许各自本地 cast JSONL payload。
- `seq` 只由 EventLog writer 分配。

### 4.7 Recipe 和 Directive

```ts
export interface RecipeDefinition {
  ref: RecipeRef;
  version: string;
  mode: 'deterministic' | 'interpreted_spec' | 'recipe_agent';
  limits?: {
    max_loop_depth?: number;
    max_activations?: number;
    max_recipe_depth?: number;
  };
}

export type Directive =
  | { kind: 'propose'; idempotency_key: string; activations: ActivationDraft[] }
  | { kind: 'wait'; idempotency_key: string; reason: string; waiting_for: string[] }
  | { kind: 'done'; idempotency_key: string; result_artifact?: ArtifactRef }
  | { kind: 'stop'; idempotency_key: string; reason: string };

export type ActivationDraft =
  Omit<Activation, 'id' | 'run_id' | 'created_by' | 'idempotency_key' | 'cache_key'> & {
    id?: ActivationId;
    created_by?: ActivationCreator;
    idempotency_key?: string;
    cache_key?: ActivationCacheKey;
  };
```

Directive 规则：

- 每个 Directive 必须有 `idempotency_key`。
- 每个 ActivationDraft 必须有或可推导出稳定 `idempotency_key`。
- 每个 ActivationDraft 必须由 ActivationFactory 计算或校验 `cache_key`，Recipe 不应手写绕过输入 hash 的 cache key。
- RecipeRunner 不直接调用 AgentAdapter。
- Workflow constructs 只生成 Directive 或 ActivationDraft。
- RecipeActivation 产出的 Directive 先作为 Artifact 写入，下一 tick 再由 WorkflowEngine 读取、校验、gate。

### 4.8 Policy

```ts
export interface Policy {
  allow_directive_from: 'recipe_only';
  budget_limits?: {
    max_total_tokens?: number;
    max_total_calls?: number;
    max_total_wall_time_ms?: number;
  };
  workflow_limits?: {
    max_activations?: number;
    max_loop_depth?: number;
    max_recipe_depth?: number;
  };
}

export type PolicyVerdict =
  | { kind: 'admit' }
  | { kind: 'wait_approval'; request: HumanRequestDraft }
  | { kind: 'reject'; reason: string }
  | { kind: 'stop'; reason: string };
```

Policy 不做业务分支，不修复失败，不替 Recipe 选择下一步。

---

## 5. Runtime 端口接口

`@agentflow/runtime` 只依赖端口，不依赖具体存储实现。

### 5.1 Store ports

```ts
export interface RunStore {
  create(record: RunRecord): Promise<void>;
  get(run_id: RunId): Promise<RunRecord | undefined>;
  updateStatus(run_id: RunId, status: RunStatus): Promise<void>;
}

export interface EventLog {
  append(
    run_id: RunId,
    event: Omit<Event, 'seq' | 'recorded_at'>
  ): Promise<Event>;

  list(run_id: RunId, afterSeq?: EventSeq): Promise<Event[]>;
}

export interface ArtifactStore {
  write<T>(artifact: Omit<Artifact<T>, 'content_hash'>): Promise<Artifact<T>>;
  get<T = unknown>(run_id: RunId, ref: ArtifactRef): Promise<Artifact<T> | undefined>;
  list(run_id: RunId): Promise<Artifact[]>;
}

export interface ActivationStore {
  put(activation: Activation): Promise<void>;
  get(run_id: RunId, id: ActivationId): Promise<Activation | undefined>;
  findByIdempotencyKey(
    run_id: RunId,
    key: string
  ): Promise<Activation | undefined>;
  findCompletedByCacheKey(
    run_id: RunId,
    key: ActivationCacheKey
  ): Promise<Activation | undefined>;
  list(run_id: RunId): Promise<Activation[]>;
}
```

### 5.2 Registry ports

```ts
export interface AgentRegistry {
  resolve(ref: AgentRef, version?: string): Promise<AgentDefinition | undefined>;
}

export interface RecipeRegistry {
  resolve(ref: RecipeRef, version?: string): Promise<RecipeDefinition | undefined>;
}

export interface SchemaRegistry {
  validate(input: {
    schema_id: SchemaId;
    payload: unknown;
  }): Promise<{ ok: true } | { ok: false; error: RuntimeError }>;
}
```

### 5.3 Adapter port

```ts
export interface AgentAdapter {
  run(input: AgentRunInput): Promise<AgentRunResult>;
}

export interface AgentRunInput {
  activation: Activation;
  agent: AgentDefinition;
  context: ContextPackage;
  expected_outputs: ExpectedOutput[];
  runtime_hints?: Capability['runtime_hints'];
}

export interface AgentRunResult {
  status: 'completed' | 'failed';
  outputs?: ProducedArtifact[];
  usage?: Usage;
  error?: RuntimeError;
}

export interface ProducedArtifact {
  ref: ArtifactRef;
  kind: ArtifactKind;
  schema_id: SchemaId;
  payload: unknown;
  views?: ArtifactViews;
  metadata?: Record<string, unknown>;
}
```

Adapter 只能返回结果，不能写 EventLog，不能写 ArtifactStore，不能调用 WorkflowEngine。`@agentflow/adapter-cli` 的 process result 需要先由 runtime binding validate/normalize，再进入这个 `AgentAdapter` result contract。

### 5.4 RuntimeDependencies

```ts
export interface RuntimeDependencies {
  run_store: RunStore;
  event_log: EventLog;
  artifact_store: ArtifactStore;
  activation_store: ActivationStore;
  agent_registry: AgentRegistry;
  recipe_registry: RecipeRegistry;
  schema_registry: SchemaRegistry;
  agent_adapters: AgentAdapterRegistry;
  clock: Clock;
  id_generator: IdGenerator;
  logger?: RuntimeLogger;
}

export interface AgentAdapterRegistry {
  resolve(ref: AgentAdapterRef): AgentAdapter | undefined;
}
```

---

## 6. Public Runtime API

### 6.1 WorkflowEngine

```ts
export interface WorkflowEngine {
  start(input: StartRunInput): Promise<RunRecord>;
  tick(run_id: RunId): Promise<RunTickResult>;
  submitHumanDecision(input: HumanResponseInput): Promise<void>;
  stop(input: StopRunInput): Promise<void>;
  getState(run_id: RunId): Promise<RunState>;
}

export interface StartRunInput {
  recipe_ref: RecipeRef;
  recipe_version?: string;
  seed_artifacts: Array<Omit<Artifact, 'run_id' | 'content_hash'>>;
  policy?: Partial<Policy>;
  metadata?: Record<string, unknown>;
}

export interface RunTickResult {
  status: RunStatus;
  ran_activations: ActivationId[];
  waiting?: WaitingState[];
  stopped_reason?: string;
  failed_error?: RuntimeError;
}

export interface StopRunInput {
  run_id: RunId;
  reason: string;
}
```

MVP 不提供 `runUntilIdle()` 作为核心 API。调用方可以循环调用 `tick()`，这样等待、审批和外部唤醒更显式。

### 6.2 HumanResponseInput

```ts
export interface HumanResponseInput {
  run_id: RunId;
  request_ref: ArtifactRef;
  decision: HumanDecision;
}

export interface HumanDecision {
  decision: 'approve' | 'reject' | 'choose' | 'revise' | 'stop';
  selected_option?: string;
  notes?: string;
  requested_changes?: string;
}
```

`submitHumanDecision()` 只写入事实，不直接执行动作。下一次 `tick()` 负责恢复或让 Recipe 分支。

---

## 7. 文件系统 MVP 存储

MVP 文件系统存储由 `@agentflow/runtime/src/storage/fs/` 内部模块提供。只有当文件存储需要独立复用或与其它 store 后端分开发布时，才抽离为独立 package。

```text
.agentflow/
  runs/
    <run_id>/
      run.json
      events.jsonl
      activations/
        <activation_id>.json
      artifacts/
        <safe_ref>.json
      blobs/
        <content_hash>.bin
      diagnostics/
        orphan-artifacts.jsonl
        recovery.jsonl
```

### 7.1 写入顺序

启动 run：

```text
1. write run.json with status=created
2. write seed artifacts by ArtifactStore.write()
3. append run.started
4. append seed artifact.written events
5. update run.json status=running
```

请求 activation：

```text
1. write activations/<activation_id>.json
2. append activation.requested
3. append activation.queued or activation.waiting_approval
```

写 Artifact：

```text
1. validate schema
2. write temp artifact file
3. fsync temp file when supported
4. atomic rename to artifacts/<safe_ref>.json
5. append artifact.written
```

完成 Activation：

```text
1. append budget.charged when usage exists
2. append activation.completed
```

### 7.2 JSONL EventLog 要求

- `seq` 由 EventLog 分配，run 内单调递增。
- append 必须是单 writer 原子操作。
- Event payload 不存大文本。
- 修改状态只能追加新 Event，不能改旧 Event。
- Event reader 必须完整读取每一行 JSON，并通过 EventDecoder。
- 损坏行视为 runtime corruption，不能静默跳过。

### 7.3 单 writer 约束

MVP 只支持同一 `run_id` 同时一个 WorkflowEngine writer。

`storage/fs` 可以实现一个轻量 lock：

```text
.agentflow/runs/<run_id>/.writer.lock
```

要求：

- lock 只防止明显并发写。
- 进程崩溃留下的 stale lock 可以由外部 recovery 命令处理。
- 不能把 lock 当作分布式一致性机制。

---

## 8. Event 与 StateProjector

### 8.1 RunState

```ts
export interface RunState {
  run: RunRecord;
  events: Event[];
  artifacts: Map<ArtifactRef, Artifact>;
  activations: Map<ActivationId, ActivationState>;
  directives: Map<string, DirectiveState>;
  budget: BudgetState;
  waiting: WaitingState[];
  workflow: WorkflowProjection;
}

export interface ActivationState {
  activation: Activation;
  status: ActivationStatus;
  requested_seq?: EventSeq;
  started_seq?: EventSeq;
  completed_seq?: EventSeq;
  failed_seq?: EventSeq;
  error?: RuntimeError;
  outputs: ArtifactRef[];
  usage?: Usage;
}

export type ActivationStatus =
  | 'proposed'
  | 'waiting_approval'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped';

export interface BudgetState {
  tokens_total: number;
  calls_total: number;
  wall_time_ms_total: number;
  limits?: Policy['budget_limits'];
  remaining?: {
    tokens?: number;
    calls?: number;
    wall_time_ms?: number;
  };
}

export interface WaitingState {
  kind: 'approval' | 'human' | 'external';
  request_ref?: ArtifactRef;
  activation_id?: ActivationId;
  reason: string;
  resolved: boolean;
}

export interface WorkflowProjection {
  loop_counters: Record<string, number>;
  branch_status: Record<string, 'running' | 'waiting' | 'done' | 'skipped'>;
  values: Record<string, unknown>;
}
```

### 8.2 Fold 顺序

```text
1. read run.json
2. read and decode events.jsonl by seq
3. initialize RunState from run record
4. for each event:
   - run.* updates run status
   - recipe.directive_recorded records directive state
   - activation.requested loads ActivationStore spec
   - activation.* updates activation status
   - artifact.written loads ArtifactStore content
   - budget.charged accumulates usage
   - approval.* and human.responded update waiting state
5. validate all referenced artifact/activation specs exist
6. return RunState
```

StateProjector 不允许：

- 从 adapter 临时 output 恢复状态。
- 读取未出现在 `artifact.written` Event 中的 Artifact 作为业务可见输入。
- 在 reducer 中本地 cast event payload。
- 修改旧 Event。

### 8.3 Event 到状态的关键映射

| Event | 投影效果 |
| --- | --- |
| `run.started` | `run.status = running` |
| `recipe.directive_recorded` | 记录本轮 Directive 和 source |
| `activation.requested` | 加载 activation spec，状态为 `proposed` |
| `activation.waiting_approval` | activation waiting，run 可进入 waiting |
| `activation.queued` | activation queued |
| `activation.started` | activation running |
| `activation.cache_hit` | 记录 cache_key 命中和 reused activation；当前 activation 不进入 running |
| `artifact.written` | artifact ref 对后续 state 可见 |
| `budget.charged` | budget totals 累加 |
| `activation.completed` | activation completed，记录 usage 和 outputs |
| `activation.failed` | activation failed，记录 error |
| `approval.requested` | 新 waiting approval |
| `human.responded` | human request resolved |
| `approval.granted` | 对应 approval 可重新 gate |
| `approval.rejected` | 对应 activation 可 skipped 或让 recipe 决策 |
| `run.completed` | run terminal completed |
| `run.stopped` | run terminal stopped |
| `run.failed` | run terminal failed |
| `phase.started` / `phase.completed` | 更新 workflow phase projection，供 CLI/UI 展示进度 |
| `progress.logged` | 记录中性进度事实，不作为业务分支条件 |
| `external.wakeup` | 外部或定时唤醒事实，供下一 tick 的 Recipe 判断 |

---

## 9. WorkflowEngine 生命周期

### 9.1 start()

```text
WorkflowEngine.start(input)
  1. create run_id
  2. resolve root RecipeDefinition
  3. merge default Policy
  4. RunStore.create(status=created)
  5. write seed artifacts
  6. append run.started
  7. append artifact.written for seed artifacts
  8. RunStore.updateStatus(running)
  9. return RunRecord
```

`start()` 不自动运行 `tick()`。调用方显式驱动，这样可以在启动后先检查 seed state。

### 9.2 tick()

```text
WorkflowEngine.tick(run_id)
  1. state = StateProjector.fold(run_id)
  2. if state.run.status is terminal: return
  3. if unresolved waiting approval blocks all runnable work: return waiting
  4. resume approved pending activations when applicable
  5. recipe = RecipeRegistry.resolve(state.run.recipe_ref)
  6. directive = RecipeRunner.decide(recipe, state)
  7. validate directive schema
  8. append recipe.directive_recorded
  9. verdict = PolicyEngine.evaluateDirective(...)
 10. handle reject / stop / wait
 11. normalize ActivationDrafts with ActivationFactory
 12. dedupe by idempotency_key
 13. check completed activation cache by cache_key
 14. append activation.cache_hit for reusable results
 15. write new activation specs and append activation.requested
 16. evaluate each new activation with PolicyEngine
 17. queue admitted activations
 18. create human requests for wait_approval verdicts
 19. ActivationRunner.drainQueue(run_id) serially
 20. final_state = StateProjector.fold(run_id)
 21. return final status and ran activation ids
```

MVP `parallel()` 语义是“一次 propose 多个 activation，并在 Recipe 语义上形成 barrier”。实际执行先串行 drain queue，后续可以只替换 ActivationQueue 和 Runner 并发策略。

### 9.3 cache / resume

Runtime 的 resume 目标不是重放所有 Agent 调用，而是只重跑输入发生变化的 Activation。

```text
ActivationFactory.computeCacheKey(activation, state)
  includes target ref/version
  includes objective + params
  includes context_request
  includes expected_outputs schema/ref
  includes capability fields that affect adapter behavior
  includes source artifact refs + content_hash
```

规则：

- `idempotency_key` 解决“同一 Directive 重复处理”的问题。
- `cache_key` 解决“同一语义输入是否需要重跑”的问题。
- completed activation 的 `cache_key` 命中时，不启动 Adapter。
- cache hit 必须追加 `activation.cache_hit`，payload 记录 `cache_key` 和 `reused_activation_id`。
- cache hit 复用的是 Artifact facts，不复制 Artifact 文件；StateProjector 通过 reused activation 找到可见 outputs。
- 任一输入 Artifact content_hash 变化，cache_key 变化，Activation 必须重新执行。

### 9.4 pipeline / barrier 运行时语义

Runtime 不需要在 MVP 实现完整 DSL，但状态模型必须区分两种推进方式：

| 构造 | Runtime 语义 | 何时继续 |
| --- | --- | --- |
| `parallel()` | 一组 Activation 形成 barrier group | group 内全部 completed / skipped / failed 后，Recipe 才处理聚合 |
| `pipeline()` | 每个 item 有独立 stage state | item 的上一 stage output 可见后，该 item 可进入下一 stage，不等待其它 item |

MVP 可以串行执行 activation，但不能把 pipeline 降级成全局 barrier。也就是说，即使 runner 当前串行，RunState 也要能表达：

```text
item A: stage 3 ready
item B: stage 1 running
item C: stage 2 waiting approval
```

Recipe 基于这些 state 决定下一步，而不是依赖临时内存 Promise 状态。

### 9.5 scheduled wakeup 未来能力

自驱 loop 不进入 MVP，但 runtime 应保留未来扩展点。推荐表达方式：

```text
Recipe decides to wait for external or timed condition
  -> append progress.logged with reason
  -> persist waiting state
  -> external scheduler later appends external.wakeup
  -> next tick folds wakeup and lets Recipe decide
```

边界：

- Runtime 不在 MVP 内实现长期定时器服务。
- `external.wakeup` 是事实输入，不是直接执行命令。
- wakeup payload 必须经过 EventDecoder。
- Recipe 仍然负责判断 wakeup 后是否继续、降级或 stop。

### 9.6 done / stop / fail

Recipe 返回 `done`：

```text
append recipe.directive_recorded
append run.completed
RunStore.updateStatus(completed)
```

Recipe 返回 `stop` 或 Policy stop：

```text
append policy.stopped when stop comes from Policy
append run.stopped
RunStore.updateStatus(stopped)
```

Runtime corruption：

```text
append run.failed if EventLog is still writable
RunStore.updateStatus(failed)
return failed error
```

如果 EventLog 已不可写，调用方得到异常，恢复命令负责检查。

---

## 10. Activation 执行路径

### 10.1 Agent target

```text
ActivationRunner.run(agent activation)
  1. append activation.started
  2. resolve AgentDefinition
  3. resolve merged Capability
  4. context = ContextBuilder.build(...)
  5. adapter = AgentAdapterRegistry.resolve(agent.adapter)
  6. result = adapter.run(...)
  7. if failed: append activation.failed and return
  8. for each output:
     - validate schema
     - ArtifactStore.write
     - append artifact.written
  9. BudgetTracker.charge(result.usage)
 10. append activation.completed
```

AgentDefinition：

```ts
export interface AgentDefinition {
  ref: AgentRef;
  version: string;
  role: string;
  adapter: AgentAdapterRef;
  default_context?: Partial<ContextRequest>;
  default_capability?: Partial<Capability>;
  output_schemas?: ExpectedOutputTemplate[];
  description?: string;
}

export interface AgentAdapterRef {
  kind: 'cli' | 'local_function' | 'mock';
  ref: string;
}
```

### 10.2 Recipe target

```text
ActivationRunner.run(recipe activation)
  1. append activation.started
  2. resolve RecipeDefinition
  3. context = ContextBuilder.build(mode='recipe')
  4. directive = RecipeRunner.runActivation(...)
  5. validate directive schema
  6. ArtifactStore.write(kind='directive')
  7. append artifact.written
  8. append recipe.directive_recorded with source=recipe_activation
  9. append activation.completed
```

RecipeActivation 的 Directive 不在当前 ActivationRunner 内立即执行。下一次 `tick()` 通过 Event/fold 读取并重新经过 Policy gate。

### 10.3 Adapter 失败分类

| 情况 | 结果 |
| --- | --- |
| AgentDefinition 找不到 | `activation.failed` with `AGENT_NOT_FOUND` |
| Adapter 找不到 | `activation.failed` with `ADAPTER_FAILED` |
| Adapter 超时 | `activation.failed` with `ADAPTER_TIMEOUT` |
| Adapter 返回 failed | `activation.failed` with adapter error |
| 输出 schema 失败 | `activation.failed` with `SCHEMA_VALIDATION_FAILED` |
| Artifact 写成功但 Event append 失败 | Artifact 暂不可见，recovery 扫描 orphan |
| budget charge 写失败 | `run.failed`，因为 usage 事实不完整 |

---

## 11. ContextBuilder

### 11.1 ContextRequest

```ts
export interface ContextRequest {
  mode:
    | 'minimal'
    | 'task'
    | 'implementation'
    | 'review'
    | 'aggregation'
    | 'memory'
    | 'recipe';
  artifacts?: ArtifactRef[];
  include?: {
    task?: boolean;
    project_index?: boolean;
    recent_events?: boolean;
    previous_outputs?: boolean;
    handoff_summary?: boolean;
    workflow_state?: boolean;
  };
  max_tokens?: number;
}

export interface ContextPackage {
  ref?: ArtifactRef;
  mode: ContextRequest['mode'];
  sections: ContextSection[];
  source_artifacts: ArtifactRef[];
  source_events: EventSeq[];
  estimated_tokens?: number;
}

export interface ContextSection {
  title: string;
  kind:
    | 'task'
    | 'artifact'
    | 'event_summary'
    | 'workflow_state'
    | 'handoff'
    | 'instruction';
  content: string;
  source_ref?: ArtifactRef;
}
```

### 11.2 构建顺序

```text
1. merge AgentDefinition.default_context and Activation.context_request
2. merge explicit artifacts and capability.visible_inputs.artifacts
3. read exact ArtifactRefs from state.artifacts
4. include task / project_index / handoff / previous_outputs by mode
5. summarize recent events through EventSummarizer
6. add compact workflow_state when requested
7. estimate tokens
8. trim by max_tokens
9. optionally persist context_package Artifact
```

### 11.3 裁剪优先级

从最先裁剪到最后保留：

```text
recent_events full detail
  -> artifact views.diff
  -> artifact views.markdown
  -> previous_outputs
  -> project_index detail
  -> fail with CONTEXT_BUILD_FAILED
```

不可裁剪掉：

- Activation objective。
- 明确要求的 required input Artifact summary。
- schema/control 相关 Artifact 的关键字段。
- human_decision 的 decision 字段。

### 11.4 何时落盘 ContextPackage

默认不落盘。以下情况写 `context_package` Artifact：

- activation metadata 要求审计。
- adapter 需要跨进程读取 context。
- 调试模式开启。
- 需要 context hash 复用。

落盘后也必须通过 `artifact.written` Event 才对后续 state 可见。

---

## 12. Policy、Budget 与 Approval

### 12.1 Directive gate

```text
PolicyEngine.evaluateDirective(policy, state, directive, source)
```

规则：

1. `allow_directive_from='recipe_only'` 时，非 recipe 或 recipe_activation source 一律 reject。
2. Directive schema 必须 strict validate。
3. Workflow limits 超限时 stop。
4. Directive idempotency_key 已处理过时跳过重复 activation。
5. `done`、`stop` 仍记录 directive，再进入终态事件。

### 12.2 Activation gate

```text
PolicyEngine.evaluateActivation(policy, state, activation, capability)
```

规则：

1. 总预算耗尽时 stop，不再 admit 新 Activation。
2. activation budget 明显不足时 reject 或 wait，MVP 推荐 stop。
3. `capability.approval.required=true` 时返回 wait_approval。
4. `target.kind='recipe'` 需要检查 recipe depth。
5. 已经 completed 且 cache_key 未变化的 activation 不重跑。
6. approval rejected 后不自动补救，由 Recipe 或 pending activation policy 决定 skipped。

### 12.3 BudgetTracker

```ts
export interface BudgetTracker {
  canStart(input: {
    state: RunState;
    policy: Policy;
    capability?: Capability;
  }): boolean;

  charge(input: {
    run_id: RunId;
    activation_id: ActivationId;
    usage: Usage;
  }): Promise<void>;
}
```

预算语义：

- `canStart` 只基于已记录 usage 判断。
- per-activation budget 是 adapter hint，不承诺强杀。
- `charge` 追加 `budget.charged` Event。
- StateProjector 根据 Policy limits 计算 `state.budget.remaining`。
- Recipe 可以读取 budget snapshot 主动缩小搜索深度、减少 fan-out 或提前 done。
- Policy 在下一次 gate 时根据总预算停止后续调度。
- 正在运行的 Activation 不因预算耗尽被中途打断。

推荐边界：

```text
Recipe budget-aware decision:
  "剩余预算不足以跑完整 panel，因此只跑 lightweight review"

Policy hard stop:
  "总预算已耗尽，不允许再启动任何 activation"
```

前者是业务/质量策略，后者是 runtime 裁决。

---

## 13. HumanInterventionManager

人工介入是 runtime 状态，不是第七原语。

### 13.1 类型

```ts
export interface HumanRequestDraft {
  question: string;
  options?: HumanOption[];
  context_refs: ArtifactRef[];
  requested_by_activation_id?: ActivationId;
  reason?: string;
}

export interface HumanOption {
  id: string;
  label: string;
  description?: string;
}

export interface HumanRequest {
  question: string;
  options?: HumanOption[];
  context_refs: ArtifactRef[];
  requested_by_activation_id?: ActivationId;
  reason?: string;
}
```

### 13.2 Capability approval 流程

```text
Policy returns wait_approval
  -> HumanInterventionManager.requestApproval
  -> write Artifact(kind='human_request')
  -> append artifact.written
  -> append approval.requested
  -> append activation.waiting_approval
  -> fold marks activation waiting_approval
```

用户响应：

```text
submitHumanDecision
  -> write Artifact(kind='human_decision')
  -> append artifact.written
  -> append human.responded
  -> append approval.granted or approval.rejected
```

下一次 `tick()`：

- approval granted：WorkflowEngine 重新 gate 该 pending activation，然后 queued。
- approval rejected：activation skipped 或交给 Recipe 读 human_decision 后选择替代路径。
- stop：append run.stopped。

### 13.3 Recipe requestHuman 流程

`requestHuman()` 属于 workflow construct。Runtime 只处理落盘和 waiting state：

```text
Recipe directive wait/request human
  -> write human_request Artifact
  -> append approval.requested or human.waiting equivalent
  -> state.waiting includes request

submitHumanDecision
  -> write human_decision Artifact
  -> append human.responded

next tick
  -> Recipe reads human_decision
  -> Recipe branches
```

MVP 可以复用 `approval.requested` 表达等待，也可以后续增加 `human.requested`。若增加新事件，必须同步更新 EventType、decoder、StateProjector 和测试。

---

## 14. RecipeRunner

### 14.1 三种 Recipe mode

| mode | MVP 行为 | 用途 |
| --- | --- | --- |
| `deterministic` | 调用注册函数，并限制隐藏非确定性 | 固定流程、单测、可重放编排 |
| `interpreted_spec` | 解释 `workflow_spec` Artifact | Planner 产 spec 后受控展开 |
| `recipe_agent` | 预留或 feature flag | 动态编排 |

### 14.2 deterministic

```ts
export interface RecipeRuntime {
  decide(state: RunState, api: WorkflowConstructApi): Promise<Directive>;
}
```

deterministic Recipe 约束：

- 只根据 `RunState`、显式参数和 `WorkflowConstructApi` 产出 Directive。
- 不直接读取系统时间、随机数、进程环境或外部网络。
- 需要时间或随机种子时，由 Runtime 作为 seed Artifact 或 Event 显式注入。
- Directive 和 ActivationDraft 必须有稳定 idempotency_key。
- cache_key 由 ActivationFactory 基于 state 中可见 Artifact content_hash 计算。

`api` 只创建 Draft 或 Directive，不执行 Agent。`parallel` / `pipeline` 是运行时状态语义，不要求 MVP 立刻提供完整用户 DSL：

```ts
export interface WorkflowConstructApi {
  agent(input: AgentConstructInput): ActivationDraft;
  recipe(input: RecipeConstructInput): ActivationDraft;
  parallel(input: ParallelConstructInput): Directive;
  pipeline(input: PipelineConstructInput): Directive;
  propose(activations: ActivationDraft[]): Directive;
  wait(input: WaitInput): Directive;
  done(input?: DoneInput): Directive;
  stop(reason: string): Directive;
}
```

### 14.3 interpreted_spec

`workflow_spec` 是受限 Activation 图，不是任意代码。

```ts
export interface WorkflowSpec {
  units: Array<{
    id: string;
    agent: AgentRef;
    objective: string;
    context: ContextRequest;
    output: ExpectedOutput;
    depends_on?: string[];
  }>;
}
```

规则：

- spec schema strict validate。
- `depends_on` 只能引用同 spec 内 unit id。
- spec 不能表达任意脚本。
- spec 不能直接设置 adapter。
- spec 展开结果仍然是 ActivationDraft，并经过 Policy gate。

---

## 15. CLI Adapter 协议

`@agentflow/adapter-cli` 是确认的独立 package 边界。Runtime 不直接实现具体 CLI 后端，也不解析 Codex、Claude、Gemini 或其它后端的私有 event stream。Runtime 只通过 `AgentAdapter` port 发起执行，并接收 adapter-cli 的归一化结果。

`ccg-workflow/codeagent-wrapper` 的参考价值在于边界思想：独立 wrapper 自己负责 backend 选择、进程调用、stdin/prompt 传输、session resume、progress 诊断、timeout 和输出归一化。agentflow 不复制它的具体语言、flag 或输出文本，只吸收“CLI wrapper 可以独立于 runtime 成为稳定协议层”的设计。

### 15.1 责任分界

Runtime 负责：

- 将 Activation、Agent 定义、ContextPackage、expected_outputs 和 runtime hints 映射为 adapter request。
- 计算 `idempotency_key` 和 `cache_key`。
- 在 adapter 返回后 schema validate artifact draft。
- 写入 ArtifactStore 和 EventLog。
- 将 selected progress telemetry 转换为 `progress.logged` Event，或直接丢弃诊断。
- 根据 RuntimeError 策略决定 retry、fail、wait 或 stop。

`@agentflow/adapter-cli` 负责：

- 选择并调用具体 backend CLI。
- 处理 prompt 的 stdin / argument / file 传输。
- 支持 `new` / `resume` session 模式。
- 管理 timeout、cancel、process exit code。
- 归一化 stdout、stderr 或 JSON event stream。
- 产出完整结构化 result JSON。
- 维护 adapter 级错误码、backend fixture 和兼容性测试。

`adapter-cli` 不写 EventLog，不写 ArtifactStore，不读 StateProjector，不决定 Recipe 分支。

### 15.2 Request 协议

Runtime 将 `AgentRunInput` 映射为 `AdapterCliRequest`。这是 wire schema，不要求 adapter-cli 依赖 runtime 私有 TypeScript 类型。

```ts
export interface AdapterCliRequest {
  schema_version: 'adapter-cli/v1';
  invocation_id: string;
  backend: string;
  mode: 'new' | 'resume';
  session_id?: string;

  cwd: string;
  prompt: string;
  input_mode?: 'stdin' | 'argument' | 'file';

  command?: string;
  args?: string[];
  env?: Record<string, string>;
  timeout_ms?: number;

  expected_outputs?: ExpectedOutputSpec[];
  runtime_hints?: {
    model?: string;
    approval?: 'default' | 'never' | 'on_request';
    sandbox?: string;
    max_output_bytes?: number;
  } & Record<string, unknown>;

  progress?: boolean;
  metadata?: Record<string, unknown>;
}
```

字段规则：

- `schema_version` 是兼容性边界。破坏性协议变更必须升版本。
- `invocation_id` 由 Runtime 生成，用于 result/progress 关联，不等同于 Activation id。
- `backend` 是 adapter-cli 的后端选择键，Runtime 不解释其内部命令形态。
- `mode='resume'` 时必须提供 `session_id`。
- `cwd` 是后端进程工作目录，adapter-cli 必须规范化并验证可用性。
- `prompt` 是完整执行输入；长文本优先用 stdin 或 request file，不强塞命令行参数。
- `expected_outputs` 是输出约束提示，不代表 adapter 可以直接写 ArtifactStore。
- `runtime_hints` 只能影响执行方式，不能承载 Runtime store handle 或私有对象。

进程调用以 request/result 文件为主，stdin/stdout 作为等价传输：

```text
agentflow-adapter-cli run --request <request.json> --result <result.json>
agentflow-adapter-cli run --request - --result -
```

### 15.3 Result 协议

Adapter 输出必须是完整 JSON，不解析固定长度前缀，不把 stderr 当业务输出。

```ts
export interface AdapterCliResult {
  schema_version: 'adapter-cli/v1';
  invocation_id: string;
  status: 'completed' | 'failed' | 'timeout' | 'cancelled';
  exit_code: number;

  message?: string;
  session_id?: string;
  outputs?: AdapterCliArtifactDraft[];
  usage?: Usage;
  progress_events?: AdapterCliProgressEvent[];
  log_path?: string;
  error?: AdapterCliError;
}

export interface AdapterCliArtifactDraft {
  kind: string;
  schema_id?: string;
  ref?: string;
  payload?: unknown;
  blob?: {
    path?: string;
    uri?: string;
    content_type?: string;
    content_hash?: string;
    size_bytes?: number;
  };
  metadata?: Record<string, unknown>;
}

export interface AdapterCliError {
  code: AdapterCliErrorCode;
  message: string;
  backend?: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export type AdapterCliErrorCode =
  | 'COMMAND_NOT_FOUND'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'INVALID_INPUT'
  | 'INVALID_OUTPUT'
  | 'BACKEND_FAILED'
  | 'PARSE_FAILED'
  | 'NO_OUTPUT';
```

Result 规则：

- `schema_version` 必须与 request 兼容。
- `invocation_id` 必须回传，Runtime 用它防止串线。
- `session_id` 是 backend continuation handle；Runtime 可保存到 activation metadata，后续 resume 再传回。
- `outputs` 是 artifact draft。Runtime 负责把它 validate / normalize 成 `ProducedArtifact`，然后写 ArtifactStore。
- 大文本输出应写入 artifact payload 或 blob 引用，不写 stderr。
- `usage` 是 adapter 观察到的用量，Runtime 仍通过 `budget.charged` Event 记账。
- `log_path` 只用于诊断，不进入业务事实。

### 15.4 Progress 协议

Progress 是可选诊断 telemetry，不是业务事实：

```ts
export interface AdapterCliProgressEvent {
  invocation_id: string;
  backend?: string;
  phase?: string;
  message?: string;
  command?: string;
  backend_event_type?: string;
  total_events?: number;
  timestamp?: string;
}
```

传输规则：

- `progress=true` 时，adapter-cli 可以向 stderr 输出 compact progress line，也可以把结构化 progress 放入 `progress_events`。
- stderr 只允许诊断和 progress，不能承载最终业务输出。
- Runtime 可以选择把部分 progress 转换成 `progress.logged` Event。
- 未写入 EventLog 的 progress 不能参与 replay、cache key 或 Recipe 分支。

### 15.5 Exit code 和错误映射

| exit code | adapter status | adapter error code | Runtime 处理建议 |
| --- | --- | --- | --- |
| `0` | `completed` | 无 | validate outputs，写 Artifact/Event |
| `1` | `failed` | `INVALID_INPUT` / `INVALID_OUTPUT` / `BACKEND_FAILED` / `PARSE_FAILED` / `NO_OUTPUT` | activation failed，按 policy 决定 retry 或 stop |
| `124` | `timeout` | `TIMEOUT` | activation failed timeout，可重试或降级 |
| `127` | `failed` | `COMMAND_NOT_FOUND` | capability/backend 配置错误，通常不重试 |
| `130` | `cancelled` | `CANCELLED` | activation cancelled 或 run stopping |
| 其它 | `failed` | `BACKEND_FAILED` | 保留原始 `exit_code`，不吞掉 backend 失败信息 |

解析失败分两层：

- request/result JSON 不完整或 schema 不合法：`INVALID_INPUT` / `INVALID_OUTPUT`。
- backend event stream 不能归一化：`PARSE_FAILED`。

Runtime 侧可以把 adapter error 映射为 `RuntimeError`，但 adapter 级错误码由 `@agentflow/adapter-cli` 维护。

### 15.6 Backend 扩展规则

新增 backend 只允许改变 adapter-cli 内部的 command、args、stdin 处理、event stream parser 和 session extraction。不能要求 Runtime 增加 backend-specific 分支。

Backend fixture 至少覆盖：

- completed result。
- failed result。
- invalid/truncated JSON。
- no output。
- timeout。
- command not found。
- session_id extraction。
- progress diagnostics。

这样 Runtime 的 `AgentAdapter` contract tests 可以稳定复用，而 backend 兼容性测试留在 `@agentflow/adapter-cli` 包内。

---

## 16. 错误、恢复与幂等

### 16.1 幂等键

幂等和缓存是两层不同机制：

| 层级 | key |
| --- | --- |
| Directive | `directive.idempotency_key` |
| Activation | `activation.idempotency_key` |
| Activation cache | `activation.cache_key` |
| Artifact | `artifact.ref + content_hash` |
| Event | `seq` |

ActivationFactory 处理同一 Directive 重复：

```text
if ActivationStore.findByIdempotencyKey(run_id, key) exists:
  reuse existing activation state
else:
  create new activation id and store spec
```

ActivationCache 处理输入未变化的 resume：

```text
cache_key = hash(target + objective + context_request + expected_outputs + runtime-affecting capability + input artifact content_hashes)

if ActivationStore.findCompletedByCacheKey(run_id, cache_key) exists:
  append activation.cache_hit(reused_activation_id)
  do not run adapter
else:
  queue activation
```

`idempotency_key` 不能替代 `cache_key`。前者是“这次提议是不是重复”，后者是“这次执行输入是否等价”。

### 16.2 崩溃恢复场景

| 崩溃点 | 恢复行为 |
| --- | --- |
| Artifact temp file 写入前崩溃 | 无事实，忽略 |
| Artifact 文件 rename 后、Event append 前崩溃 | Artifact orphan，fold 不可见，recovery 记录 diagnostics |
| activation.started 后、adapter 返回前崩溃 | 下次 recovery 标记 stale running 为 failed |
| budget.charged 前崩溃 | usage 不完整，该 activation 不能 completed |
| activation.completed append 后崩溃 | fold 可恢复 completed |
| recipe.directive_recorded 后崩溃 | 根据 directive idempotency_key 去重继续 |
| activation.cache_hit append 后崩溃 | fold 可恢复 reused activation，不启动 adapter |
| EventLog 损坏 | run failed，需要人工恢复 |

### 16.3 stale running

MVP 不尝试自动重跑 running activation。恢复命令执行：

```text
StateProjector.fold
find activation.status=running and started_at older than threshold
append activation.failed with code=STALE_RUNNING
append progress.logged diagnostics
```

后续是否重新尝试由 Recipe 决定。

### 16.4 schema failure

输出 schema 失败：

```text
1. write diagnostic artifact only when debug enabled
2. append artifact.written for diagnostic if written
3. append activation.failed with SCHEMA_VALIDATION_FAILED
4. expected output ref remains absent
5. Recipe sees failure state on next tick
```

diagnostic Artifact 必须标记：

```ts
metadata: {
  visibility: 'diagnostic',
  failed_expected_ref: '...'
}
```

Recipe 默认不把 diagnostic Artifact 当正常业务输入。

### 16.5 budget exhausted

预算耗尽发生在调度边界：

```text
PolicyEngine.evaluateActivation
  -> sees state.budget over limit
  -> append policy.stopped
  -> append run.stopped
```

如果预算在某个 Activation 完成后才超限，已完成结果仍然保留，后续 Activation 不再启动。

---

## 17. 日志与诊断

Runtime 日志是辅助诊断，不是状态来源。

建议结构化字段：

```ts
export interface RuntimeLogFields {
  run_id?: RunId;
  activation_id?: ActivationId;
  event_seq?: EventSeq;
  artifact_ref?: ArtifactRef;
  component: string;
  action: string;
}
```

必须写 Event 的事实不要只写日志：

- run 状态变化。
- activation 状态变化。
- activation cache hit。
- artifact 可见性。
- budget charge。
- human request/decision。
- policy stop/reject。
- phase/progress/wakeup。

日志中禁止写入：

- credential。
- 未裁剪的完整 Agent context。
- 大段模型输出。
- 用户敏感数据的未脱敏版本。

---

## 18. MVP 实现切片

### Slice 1：contracts 类型与 schema

交付：

- `src/contracts/` 内的 Activation、Capability、Artifact、Event、Recipe、Policy 类型。
- RuntimeError 类型。
- Event decoder 和基础 type guard。
- Directive、workflow_spec、human_decision strict schema。

验收：

- schema failure 能返回结构化错误。
- Event decoder 拒绝未知或损坏事件。

### Slice 2：文件存储

交付：

- FsRunStore。
- FsEventLog。
- FsArtifactStore。
- FsActivationStore。
- safe ref escaping。
- atomic write。

验收：

- seed artifact 写入后可读。
- JSONL seq 单调递增。
- Artifact 写入后没有 Event 时 fold 不可见。

### Slice 3：StateProjector

交付：

- Event fold。
- activation state reducer。
- activation cache_hit reducer。
- artifact loading。
- budget reducer 和 remaining projection。
- waiting reducer。
- phase/progress/wakeup projection。

验收：

- 清空内存后从文件恢复同一 RunState。
- 缺失 artifact/spec 报 runtime corruption。

### Slice 4：Registry 和 mock adapter

交付：

- StaticAgentRegistry。
- StaticRecipeRegistry。
- InMemorySchemaRegistry。
- MockAgentAdapter。

验收：

- mock adapter 返回 role_output Artifact。
- adapter 不能写 store。

### Slice 5：单 Agent tick

交付：

- WorkflowEngine.start。
- deterministic RecipeRunner。
- ActivationFactory。
- ActivationCache。
- ActivationRunner agent path。
- serial ActivationQueue。

验收：

- seed task -> recipe propose agent -> role_output Artifact -> run completed。
- Event 顺序完整。
- 相同 cache_key 的 completed activation 不重跑 adapter，并记录 activation.cache_hit。

### Slice 6：Policy 和 Budget

交付：

- Directive source gate。
- Activation approval gate。
- BudgetTracker。
- workflow limit gate。
- budget snapshot / remaining 进入 RunState。

验收：

- 普通 Agent 产 directive 不会被执行。
- Recipe 可以根据 remaining budget 选择更小 fan-out。
- budget exhausted 后后续 activation 不启动。

### Slice 7：HumanIntervention

交付：

- human_request Artifact。
- human_decision Artifact。
- submitHumanDecision。
- approval granted/rejected fold。

验收：

- approval required -> run waiting。
- approve -> 下一 tick resume。
- reject/stop -> 不启动 pending activation。

### Slice 8：RecipeActivation 和 interpreted_spec

交付：

- recipe target execution path。
- directive Artifact strict validation。
- interpreted workflow_spec runner。

验收：

- RecipeActivation 产 directive 后下一 tick 执行。
- workflow_spec 只能展开受限 Activation 图。

### Slice 8.5：pipeline / barrier state

交付：

- parallel barrier group state。
- pipeline item/stage readiness projection。
- phase.started / phase.completed / progress.logged 基础投影。

验收：

- parallel group 未全部完成前，Recipe 不执行聚合分支。
- pipeline item A 可进入下一 stage 时，不等待 item B。
- phase/progress 事件可投影给 CLI/UI，但不作为业务事实替代 Artifact。

### Slice 9：`@agentflow/adapter-cli` protocol

交付：

- `packages/adapter-cli` 的 request/result/progress/error wire schema。
- process invocation 规范：request/result file 与 stdin/stdout 等价传输。
- timeout、cancel、command-not-found、invalid-output、backend-failed 的结构化错误映射。
- runtime `AgentAdapter` boundary mapper，负责把 adapter result validate/normalize 为 runtime output。
- backend fixture 分类，而不是 runtime 内置 backend-specific parser。

验收：

- 完整 JSON result 被 Runtime validate 后写成 ProducedArtifact。
- truncated/invalid JSON 映射为 `INVALID_OUTPUT` 或 `PARSE_FAILED`，Runtime 不从 stderr 补业务输出。
- `session_id` 可以被保存并用于后续 resume request。
- progress diagnostics 不写 EventLog 时，不影响 replay/cache/Recipe 分支。
- Runtime 中没有 Codex/Claude/Gemini 等 backend-specific stream parser。

---

## 19. 必须测试的场景

| 场景 | 断言 |
| --- | --- |
| 单 Agent run | Event 顺序完整，role_output 可读，run completed |
| Agent 产 directive | Artifact 可保存，但不会被执行为控制流 |
| RecipeActivation 产 directive | schema 通过后下一 tick 可执行 |
| ContextBuilder 裁剪 | 超 token 时按优先级裁剪或失败 |
| approval required | run waiting，写 human_request |
| human approve | 写 human_decision，下一 tick resume |
| human reject | pending activation skipped 或 recipe 替代分支 |
| budget exhausted | 后续 activation stop/reject |
| crash recovery | 清空内存后 fold 可恢复状态 |
| stale running | running activation 标记 failed stale |
| schema failure | activation failed，不污染 expected output |
| orphan artifact | 没有 artifact.written 时 fold 不可见 |
| event decoder | raw JSONL payload 只在事件层 decode |
| duplicate directive | idempotency_key 避免重复 activation |
| activation cache hit | cache_key 相同且输入 hash 未变时不重跑 adapter |
| changed input hash | Artifact content_hash 变化后 cache_key 变化并重新执行 |
| deterministic recipe | deterministic mode 不依赖隐藏时间、随机数或外部网络 |
| pipeline no barrier | 单个 item 可独立进入下一 stage |
| parallel barrier | 聚合前必须等待 group 完成 |
| budget-aware recipe | Recipe 能读取 remaining budget 并减少 fan-out |
| phase/progress events | phase/progress 可 replay，不由日志推断 |
| adapter-cli completed | adapter result validate 后才写 ProducedArtifact |
| adapter-cli invalid output | truncated/invalid JSON 映射为 adapter error，不解析 stderr 作为业务输出 |
| adapter-cli timeout | exit `124` 映射为 `TIMEOUT` |
| adapter-cli command missing | exit `127` 映射为 `COMMAND_NOT_FOUND` |
| adapter-cli resume | Runtime 传入 `session_id`，adapter result 回传 continuation handle |
| adapter-cli progress | 未转换成 `progress.logged` Event 的 telemetry 不进入 replay state |

---

## 20. Runtime 设计验收清单

- [ ] 第一阶段明确 `@agentflow/runtime` 和 `@agentflow/adapter-cli` 两个 package 边界。
- [ ] `contracts/` 只包含纯契约，不包含执行。
- [ ] 新 package 只有满足抽离条件后才创建。
- [ ] `engine/` 通过端口调用 storage 和 adapters，不依赖具体实现私有细节。
- [ ] `@agentflow/adapter-cli` 通过稳定 request/result/progress/error 协议运行，不依赖 runtime engine/store 私有类型。
- [ ] Runtime 不解析 backend-specific CLI stream，只消费 `AgentAdapter` 的归一化结果。
- [ ] stderr/progress 不被当成业务输出；只有 Runtime 写入 EventLog 后才成为可 replay fact。
- [ ] 普通 Agent 输出不会直接驱动调度。
- [ ] Recipe 和 RecipeActivation 的 Directive 必须 schema validate。
- [ ] deterministic Recipe 决策可重放。
- [ ] Activation 是唯一执行边界。
- [ ] `idempotency_key` 和 `cache_key` 职责区分清晰。
- [ ] cache hit 有 EventLog 事实，不靠内存判断。
- [ ] Artifact 只有经过 `artifact.written` Event 才进入 RunState。
- [ ] EventLog 是 append-only，seq 单调递增。
- [ ] StateProjector 是唯一状态 fold 入口。
- [ ] Event payload 类型、decoder、projection 有单一责任方。
- [ ] pipeline 和 parallel barrier 的状态语义可投影。
- [ ] Capability 不承担强 sandbox。
- [ ] ContextBuilder 不创造业务事实。
- [ ] BudgetTracker 不中途打断 Agent，但 RunState 暴露 remaining budget。
- [ ] Human decision 不直接执行动作，只写事实，下一 tick 继续。
- [ ] phase/progress/wakeup 是可 replay 的 runtime facts。
- [ ] 文件存储 MVP 支持崩溃恢复和 orphan 诊断。
- [ ] 每个 MVP slice 都有独立验收测试。

---

## 21. 第一阶段最终边界

第一阶段 runtime 完成后，只要求跑通以下闭环：

```text
start run
  -> fold seed state
  -> deterministic recipe proposes activation
  -> policy admits
  -> activation factory computes idempotency_key and cache_key
  -> completed cache hit is recorded or new activation is queued
  -> context builder builds input
  -> mock adapter or @agentflow/adapter-cli binding returns output
  -> artifact and events persist
  -> projector recovers state
  -> recipe marks done or waits/stops
```

不要求第一阶段完成：

- 并发 worker。
- 远程队列。
- 完整 workflow DSL。
- 完整实现所有 `adapter-cli` backend parser 和跨平台二进制分发。
- 独立拆分 `runtime-fs` / `testkit` 等 package。
- 标准 Agent 生态。
- UI。
- 强权限系统。

这条边界能让 runtime 先成为一个小而可靠的事实机：所有可见状态都来自 Event 和 Artifact，所有执行都经过 Activation，所有编排都经过 Recipe 和 Policy，所有可复用执行都由 cache_key 和 EventLog 共同证明。`adapter-cli` 的独立性先由 package 边界和 wire protocol 保证，backend 覆盖可以逐步补齐。
