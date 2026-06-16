# agentflow 原语与 Runtime 详细设计：可初步落地版本

> 生成日期：2026-06-16
> 性质：**详细设计草案**。本文承接 `agentflow-primitive-refinement-preview.md`，只细化原语层和 Runtime Framework，不展开具体业务场景。
> 目标：给出可以开始实现 MVP 的数据结构、模块边界、事件流、状态机和最小存储布局。

---

## 一、设计范围

本文只覆盖两层：

```text
Primitive Layer
  Activation / Capability / Artifact / Event / Recipe / Policy
  + AgentDefinition / ContextRequest 作为框架层定义

Runtime Framework
  RunStore / ArtifactStore / EventLog
  AgentRegistry / RecipeRegistry
  ContextBuilder
  ActivationRunner
  RecipeRunner
  WorkflowEngine
  BudgetTracker
  HumanInterventionManager
```

不覆盖：

- 具体 Planner / Generator / Evaluator 场景；
- 完整 workflow DSL；
- 强 sandbox / 文件权限 / 网络权限系统；
- 工具调用级拦截；
- 分布式执行；
- 完整 UI。

MVP 的目标是让一个 run 可以：

1. 创建 seed Artifact；
2. 运行 Recipe；
3. propose Agent/Recipe Activation；
4. 构建 ContextPackage；
5. 调用 Agent adapter；
6. 写 Artifact 和 Event；
7. 支持 branch / loop 的状态推进；
8. 支持人工介入等待和恢复；
9. 支持预算耗尽后停止后续调度；
10. 从 Event + Artifact 恢复 SessionState。

---

## 二、核心约束

### 2.1 控制权约束

```text
只有 Recipe / RecipeActivation 可以产出可执行 Directive。
普通 AgentActivation 可以产出 plan / workflow_spec Artifact，但不能直接调度。
```

运行时必须拒绝：

```text
AgentActivation -> directive Artifact -> 直接执行
```

必须走：

```text
AgentActivation -> workflow_spec Artifact
RecipeActivation / RecipeRunner -> validate + expand -> Directive
```

### 2.2 Capability 轻量约束

Capability 不做细粒度安全。

它只回答：

```text
work_mode 是什么？
ContextBuilder 应暴露哪些输入？
最多大致花多少预算？
启动前是否需要人工确认？
给 Agent adapter 哪些运行 hint？
```

它不做：

- 文件读写权限；
- 网络权限；
- 工具调用拦截；
- 中途打断 Activation；
- destructive operation 审批；
- credential vault。

### 2.3 状态约束

```text
Artifact = Activation 的持久输出
Event = append-only 事实
ContextPackage = Agent/Recipe 调用输入，可选落为 Artifact
SessionState = fold(EventLog, ArtifactStore)
```

Agent 内部上下文不是系统状态。只有写入 Artifact/Event 的内容才影响后续 workflow。

---

## 三、Primitive 数据模型

### 3.1 公共类型

```ts
type RunId = string;
type ActivationId = string;
type ArtifactRef = string;
type AgentRef = string;
type RecipeRef = string;
type SchemaId = string;
type ContentHash = string;

interface VersionedRef {
  ref: string;
  version?: string;
}

interface Usage {
  tokens_input?: number;
  tokens_output?: number;
  tokens_total?: number;
  calls?: number;
  wall_time_ms?: number;
}
```

### 3.2 Activation

Activation 是 Runtime 可启动的最小边界。MVP 中 target 只允许 `agent` 或 `recipe`。

```ts
interface Activation {
  id: ActivationId;
  run_id: RunId;

  target: ActivationTarget;
  objective: ActivationObjective;

  context_request: ContextRequest;
  expected_outputs: ExpectedOutput[];

  capability?: Capability;

  parent_activation_id?: ActivationId;
  status: ActivationStatus;

  created_by: ActivationCreator;
  metadata?: ActivationMetadata;
}

type ActivationTarget =
  | { kind: 'agent'; ref: AgentRef; version?: string }
  | { kind: 'recipe'; ref: RecipeRef; version?: string };

type ActivationStatus =
  | 'proposed'
  | 'waiting_approval'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'cancelled';

interface ActivationObjective {
  title: string;
  instructions?: string;
  params?: Record<string, unknown>;
}

interface ExpectedOutput {
  ref: ArtifactRef;
  kind: ArtifactKind;
  schema_id: SchemaId;
  required: boolean;
}

interface ActivationCreator {
  kind: 'recipe' | 'recipe_activation' | 'system';
  ref?: string;
  activation_id?: ActivationId;
}

interface ActivationMetadata {
  phase?: string;
  group?: string;
  priority?: number;
  loop_id?: string;
  branch_id?: string;
  tags?: string[];
}
```

实现规则：

1. `created_by.kind` 必须可追溯。
2. `target.kind='recipe'` 的 Activation 只能产出 `directive` Artifact。
3. `target.kind='agent'` 的 Activation 如果产出 `directive` Artifact，Runtime 必须拒绝解释。
4. `status` 可由 Event fold 得到，存储中可以冗余缓存，但 Event 是事实来源。

### 3.3 AgentDefinition

Agent 不是原语，但 Runtime 必须有 registry。

```ts
interface AgentDefinition {
  ref: AgentRef;
  version: string;
  adapter: AgentAdapterRef;
  description?: string;

  default_context?: Partial<ContextRequest>;
  default_capability?: Partial<Capability>;

  output_schemas?: ExpectedOutputTemplate[];
}

interface AgentAdapterRef {
  kind: 'cli' | 'mock' | 'local_function';
  ref: string;
}

interface ExpectedOutputTemplate {
  kind: ArtifactKind;
  schema_id: SchemaId;
}
```

MVP adapter 只需要支持：

```ts
interface AgentAdapter {
  run(input: AgentRunInput): Promise<AgentRunResult>;
}

interface AgentRunInput {
  activation: Activation;
  agent: AgentDefinition;
  context: ContextPackage;
  expected_outputs: ExpectedOutput[];
  runtime_hints?: RuntimeHints;
}

interface AgentRunResult {
  status: 'completed' | 'failed';
  outputs?: ProducedArtifact[];
  usage?: Usage;
  error?: {
    code: string;
    message: string;
  };
}

interface ProducedArtifact {
  ref: ArtifactRef;
  kind: ArtifactKind;
  schema_id: SchemaId;
  payload: unknown;
  views?: ArtifactViews;
}
```

### 3.4 Capability

Capability 是启动前运行边界。

```ts
interface Capability {
  work_mode: WorkMode;
  visible_inputs?: VisibleInputs;
  budget?: ActivationBudget;
  approval?: ApprovalRequirement;
  runtime_hints?: RuntimeHints;
}

type WorkMode =
  | 'plan'
  | 'execute'
  | 'review'
  | 'aggregate'
  | 'summarize'
  | 'memory'
  | 'recipe';

interface VisibleInputs {
  artifacts?: ArtifactRef[];
  include_task?: boolean;
  include_project_index?: boolean;
  include_recent_events?: boolean;
  include_previous_outputs?: boolean;
  include_handoff_summary?: boolean;
  include_workflow_state?: boolean;
}

interface ActivationBudget {
  max_tokens?: number;
  max_calls?: number;
  max_wall_time_ms?: number;
}

interface ApprovalRequirement {
  required: boolean;
  reason?: string;
  prompt?: string;
}

interface RuntimeHints {
  model?: string;
  output_format?: 'json' | 'markdown' | 'patch' | 'mixed';
  temperature?: number;
}
```

实现规则：

1. `Capability` 可以来自 Agent 默认值、Recipe 指定值和 Activation override。
2. 合并策略采用“Activation override 优先”。
3. `visible_inputs` 与 `context_request` 都会进入 ContextBuilder，后者负责最终选择。
4. `budget` 是启动前和完成后记账依据，不承诺运行中强杀。
5. `approval.required=true` 时 Activation 进入 `waiting_approval`，由 HumanInterventionManager 处理。

### 3.5 Artifact

Artifact 是持久输出。MVP 可以存 JSON payload，也允许大内容用 `storage_uri`。

```ts
interface Artifact<T = unknown> {
  ref: ArtifactRef;
  run_id: RunId;

  kind: ArtifactKind;
  schema_id: SchemaId;
  content_hash: ContentHash;

  producer_activation_id?: ActivationId;
  payload?: T;
  storage_uri?: string;

  views?: ArtifactViews;
  metadata?: Record<string, unknown>;
}

type ArtifactKind =
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
  | 'final_report';

interface ArtifactViews {
  markdown?: string;
  summary?: string;
  diff?: string;
}
```

实现规则：

1. Artifact 写入时必须计算 `content_hash`。
2. 同一 `ref` 可以多版本，MVP 可以先采用“最后写 wins + Event 保留历史”。
3. Recipe 控制流只能读取 schema 校验通过的 Artifact。
4. MVP 可以先实现 schema registry 的占位校验：已知 schema 严格校验，未知 schema 只记录 warning。

### 3.6 Event

Event 是 append-only 事实流。

```ts
interface Event {
  seq: number;
  run_id: RunId;
  type: EventType;

  activation_id?: ActivationId;
  artifact_ref?: ArtifactRef;

  payload?: Record<string, unknown>;
  recorded_at: string;
}

type EventType =
  | 'run.started'
  | 'run.completed'
  | 'run.stopped'
  | 'activation.requested'
  | 'activation.waiting_approval'
  | 'activation.queued'
  | 'activation.started'
  | 'activation.completed'
  | 'activation.failed'
  | 'activation.skipped'
  | 'artifact.written'
  | 'recipe.directive_recorded'
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

实现规则：

1. `seq` 在 run 内单调递增。
2. 大内容不放 Event，放 Artifact。
3. `recorded_at` 只用于审计；Recipe 分支如果依赖时间，必须依赖 `external.wakeup` 或显式时间 Artifact/Event。

### 3.7 Recipe

Recipe 是编排规则。MVP 支持 deterministic 和 interpreted_spec；recipe_agent 可以预留。

```ts
interface RecipeDefinition {
  ref: RecipeRef;
  version: string;
  mode: 'deterministic' | 'interpreted_spec' | 'recipe_agent';

  limits?: RecipeLimits;
}

interface RecipeLimits {
  max_loop_depth?: number;
  max_activations?: number;
  max_recipe_depth?: number;
}

type Directive =
  | { kind: 'propose'; activations: Activation[] }
  | { kind: 'wait'; reason: string; waiting_for: string[] }
  | { kind: 'done'; result_artifact?: ArtifactRef }
  | { kind: 'stop'; reason: string };
```

Recipe 函数接口：

```ts
interface RecipeRuntime {
  decide(state: SessionState, ctx: RecipeContext): Promise<Directive>;
}

interface RecipeContext {
  recipe: RecipeDefinition;
  construct: WorkflowConstructApi;
}
```

实现规则：

1. `decide` 不直接调用 Agent adapter。
2. Workflow constructs 只构造 Activation/Directive，不直接执行。
3. `Directive` 必须写入 `recipe.directive_recorded` Event。
4. `Directive.kind='wait'` 表示 run 没有失败，只是在等待外部输入、人审或依赖。

### 3.8 Policy

Policy 是轻量编排裁决。

```ts
interface Policy {
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

type PolicyVerdict =
  | { kind: 'admit' }
  | { kind: 'wait_approval'; request: HumanRequest }
  | { kind: 'reject'; reason: string }
  | { kind: 'stop'; reason: string };
```

实现规则：

1. 拒绝非 Recipe 来源的 Directive。
2. 预算耗尽后不再 admit 新 Activation。
3. loop/depth 超限后返回 stop。
4. `approval.required` 返回 `wait_approval`。
5. Policy 不做业务目标选择，业务分支由 Recipe 完成。

---

## 四、Runtime 数据结构

### 4.1 RunRecord

```ts
interface RunRecord {
  run_id: RunId;
  status: RunStatus;
  recipe_ref: RecipeRef;
  created_at: string;
  updated_at: string;
  policy: Policy;
}

type RunStatus =
  | 'running'
  | 'waiting'
  | 'completed'
  | 'stopped'
  | 'failed';
```

### 4.2 SessionState

`SessionState` 是 fold 结果，Recipe 和 Policy 只读它。

```ts
interface SessionState {
  run: RunRecord;
  events: Event[];
  artifacts: Map<ArtifactRef, Artifact>;
  activations: Map<ActivationId, ActivationState>;
  budget: BudgetState;
  waiting: WaitingState[];
  workflow: WorkflowState;
}

interface ActivationState {
  spec: Activation;
  status: ActivationStatus;
  outputs: ArtifactRef[];
  error?: {
    code: string;
    message: string;
  };
  usage?: Usage;
}

interface BudgetState {
  tokens_total: number;
  calls_total: number;
  wall_time_ms_total: number;
}

interface WaitingState {
  kind: 'human' | 'external' | 'dependency';
  key: string;
  activation_id?: ActivationId;
  artifact_ref?: ArtifactRef;
  since_seq: number;
}

interface WorkflowState {
  loop_counters: Record<string, number>;
  branch_status: Record<string, 'running' | 'waiting' | 'done' | 'skipped'>;
  values: Record<string, unknown>;
}
```

### 4.3 fold 规则

MVP fold 可以先简单实现：

```text
run.started                  -> run.status = running
activation.requested          -> activations[id].status = proposed
activation.waiting_approval   -> status = waiting_approval; waiting += human
activation.queued             -> status = queued
activation.started            -> status = running
artifact.written              -> artifacts[ref] = artifact; activation.outputs += ref
activation.completed          -> status = completed; usage += payload.usage
activation.failed             -> status = failed
budget.charged                -> budget += usage
human.responded               -> waiting human resolved; artifact human_decision visible
run.completed                 -> run.status = completed
run.stopped                   -> run.status = stopped
```

Event 是事实来源，ArtifactStore 是内容来源。`fold` 可以读取 Event 后再查 ArtifactStore 填充 `artifacts`。

---

## 五、Runtime 模块接口

### 5.1 EventLog

```ts
interface EventLog {
  append(run_id: RunId, event: Omit<Event, 'seq' | 'recorded_at'>): Promise<Event>;
  list(run_id: RunId): Promise<Event[]>;
}
```

要求：

- append 必须原子分配 `seq`。
- MVP 可用文件锁或单进程内存锁。

### 5.2 ArtifactStore

```ts
interface ArtifactStore {
  write<T>(artifact: Omit<Artifact<T>, 'content_hash'>): Promise<Artifact<T>>;
  read<T = unknown>(run_id: RunId, ref: ArtifactRef): Promise<Artifact<T> | undefined>;
  list(run_id: RunId): Promise<Artifact[]>;
}
```

要求：

- `write` 计算 hash。
- 写入成功后由调用方 append `artifact.written` Event。
- MVP 使用 JSON 文件即可。

### 5.3 Registry

```ts
interface AgentRegistry {
  get(ref: AgentRef, version?: string): AgentDefinition | undefined;
}

interface RecipeRegistry {
  get(ref: RecipeRef, version?: string): RecipeDefinition | undefined;
  runtime(ref: RecipeRef, version?: string): RecipeRuntime | undefined;
}
```

MVP 可用静态对象注册。

### 5.4 ContextBuilder

```ts
interface ContextBuilder {
  build(input: ContextBuildInput): Promise<ContextPackage>;
}

interface ContextBuildInput {
  run_id: RunId;
  state: SessionState;
  activation: Activation;
  request: ContextRequest;
  visible_inputs?: VisibleInputs;
}

interface ContextRequest {
  mode: ContextMode;
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

type ContextMode =
  | 'minimal'
  | 'task'
  | 'implementation'
  | 'review'
  | 'aggregation'
  | 'memory'
  | 'recipe';

interface ContextPackage {
  ref?: ArtifactRef;
  mode: ContextMode;
  sections: ContextSection[];
  source_artifacts: ArtifactRef[];
  source_events: number[];
  estimated_tokens?: number;
}

interface ContextSection {
  title: string;
  kind: 'task' | 'artifact' | 'event_summary' | 'workflow_state' | 'handoff' | 'instruction';
  content: string;
  source_ref?: ArtifactRef;
}
```

MVP ContextBuilder 策略：

1. `include.task` 读取 `kind='task'` 最新 Artifact。
2. `include.project_index` 读取 `kind='project_index'`。
3. `artifacts` 按 ref 精确读取。
4. `recent_events` 只生成摘要，不塞完整 payload。
5. `handoff_summary` 读取最新 `kind='handoff'` 或 `summary`。
6. 超过 `max_tokens` 时优先丢 recent events，再丢 views，最后报错。

### 5.5 PolicyEngine

```ts
interface PolicyEngine {
  evaluateActivation(input: PolicyActivationInput): PolicyVerdict;
  evaluateDirective(input: PolicyDirectiveInput): PolicyVerdict;
}

interface PolicyActivationInput {
  policy: Policy;
  state: SessionState;
  activation: Activation;
}

interface PolicyDirectiveInput {
  policy: Policy;
  state: SessionState;
  directive: Directive;
  source: ActivationCreator;
}
```

MVP 规则：

- `evaluateDirective` 检查 source 是否 recipe。
- `evaluateActivation` 检查 budget、workflow limits、approval。

### 5.6 BudgetTracker

```ts
interface BudgetTracker {
  canStart(state: SessionState, capability?: Capability): boolean;
  charge(run_id: RunId, activation_id: ActivationId, usage: Usage): Promise<void>;
}
```

`charge` 写 `budget.charged` Event。

### 5.7 HumanInterventionManager

```ts
interface HumanInterventionManager {
  request(input: HumanRequestInput): Promise<HumanRequestResult>;
  respond(input: HumanResponseInput): Promise<Artifact<HumanDecision>>;
}

interface HumanRequestInput {
  run_id: RunId;
  activation_id?: ActivationId;
  question: string;
  options?: HumanOption[];
  context_refs: ArtifactRef[];
}

interface HumanOption {
  id: string;
  label: string;
  description?: string;
}

interface HumanRequestResult {
  request_artifact: Artifact<HumanRequest>;
}

interface HumanRequest {
  question: string;
  options?: HumanOption[];
  context_refs: ArtifactRef[];
  requested_by_activation_id?: ActivationId;
}

interface HumanResponseInput {
  run_id: RunId;
  request_ref: ArtifactRef;
  decision: HumanDecision;
}

interface HumanDecision {
  decision: 'approve' | 'reject' | 'choose' | 'revise' | 'stop';
  selected_option?: string;
  notes?: string;
  requested_changes?: string;
}
```

MVP 行为：

1. `request` 写 `human_request` Artifact 和 `approval.requested` Event。
2. 当前 Activation 写 `activation.waiting_approval` Event。
3. `respond` 写 `human_decision` Artifact 和 `human.responded` Event。
4. WorkflowEngine 下一轮 fold 后继续 Recipe。

### 5.8 ActivationRunner

```ts
interface ActivationRunner {
  run(input: ActivationRunInput): Promise<void>;
}

interface ActivationRunInput {
  run_id: RunId;
  activation: Activation;
  state: SessionState;
}
```

执行流程：

```text
append activation.started

if target.kind == 'agent':
  agent = AgentRegistry.get
  context = ContextBuilder.build
  result = AgentAdapter.run
  write outputs
  append artifact.written for each output
  append budget.charged
  append activation.completed or activation.failed

if target.kind == 'recipe':
  context = ContextBuilder.build
  directive = RecipeRunner.runActivation
  write directive Artifact
  append recipe.directive_recorded
  append activation.completed
```

注意：

- Recipe Activation 产出的 Directive 不在 Runner 内直接执行，而是交给 WorkflowEngine 下一拍处理。
- Agent output schema 校验失败，MVP 可以把 Activation 标记 failed，并保留 raw role_output Artifact。

### 5.9 RecipeRunner

```ts
interface RecipeRunner {
  decide(input: RecipeRunInput): Promise<Directive>;
}

interface RecipeRunInput {
  run_id: RunId;
  recipe: RecipeDefinition;
  state: SessionState;
}
```

MVP 支持：

1. deterministic recipe：直接调用注册函数。
2. interpreted_spec recipe：读取 workflow_spec Artifact，解释为 Activation proposals。

`recipe_agent` 可以保留接口，不在 MVP 实现。

### 5.10 WorkflowEngine

```ts
interface WorkflowEngine {
  start(input: StartRunInput): Promise<RunRecord>;
  tick(run_id: RunId): Promise<RunTickResult>;
  submitHumanDecision(input: HumanResponseInput): Promise<void>;
}

interface StartRunInput {
  recipe_ref: RecipeRef;
  seed_artifacts: Omit<Artifact, 'run_id' | 'content_hash'>[];
  policy?: Policy;
}

interface RunTickResult {
  status: RunStatus;
  ran_activations: ActivationId[];
  waiting?: WaitingState[];
}
```

`tick` 是 MVP 的核心循环：

```text
1. state = fold(run)
2. if run terminal: return
3. recipe = RecipeRegistry.get(run.recipe_ref)
4. directive = RecipeRunner.decide(state)
5. append recipe.directive_recorded
6. PolicyEngine.evaluateDirective
7. if done/stop/wait: update events and return
8. for each proposed activation:
     PolicyEngine.evaluateActivation
     if wait_approval -> HumanInterventionManager.request
     if admit -> append activation.requested + queued
9. run queued activations sequentially in MVP
10. fold and return status
```

MVP 先串行执行 queued Activation；parallel/pipeline 只体现在 Recipe 一次 propose 多个 Activation，后续再加并发 runner。

---

## 六、存储布局 MVP

使用文件系统即可：

```text
.agentflow/
  runs/
    <run_id>/
      run.json
      events.jsonl
      artifacts/
        <safe-ref>.json
      blobs/
        <hash>.bin
```

Artifact ref 到文件名：

```text
planner/package.json -> artifacts/planner__package.json.json
units/auth/verdict.json -> artifacts/units__auth__verdict.json.json
```

MVP 可以先用简单 escape，后续再换索引。

`events.jsonl` 示例：

```jsonl
{"seq":1,"run_id":"run-1","type":"run.started","recorded_at":"...","payload":{"recipe_ref":"long-running-app-dev"}}
{"seq":2,"run_id":"run-1","type":"artifact.written","artifact_ref":"task","recorded_at":"..."}
{"seq":3,"run_id":"run-1","type":"recipe.directive_recorded","recorded_at":"...","payload":{"kind":"propose","count":1}}
```

---

## 七、MVP 执行状态机

### 7.1 Activation 状态机

```text
proposed
  -> waiting_approval
     -> queued
     -> skipped
  -> queued
     -> running
        -> completed
        -> failed
```

说明：

- approval approve 后进入 queued。
- approval reject 后进入 skipped，Recipe 下一轮决定替代路径。
- failed 不自动重试；retry 是 Recipe/Workflow construct 的后续能力。

### 7.2 Run 状态机

```text
running
  -> waiting
  -> completed
  -> stopped
  -> failed

waiting
  -> running
  -> stopped
```

说明：

- `waiting` 用于人审、外部事件、依赖未满足。
- Run 可以在 `waiting` 中持久化并退出进程。
- 外部响应写 Event 后，下一次 `tick` 恢复。

---

## 八、错误与恢复

### 8.1 错误类型

```ts
type RuntimeErrorCode =
  | 'AGENT_NOT_FOUND'
  | 'RECIPE_NOT_FOUND'
  | 'SCHEMA_VALIDATION_FAILED'
  | 'AGENT_RUN_FAILED'
  | 'DIRECTIVE_SOURCE_REJECTED'
  | 'BUDGET_EXHAUSTED'
  | 'APPROVAL_REJECTED'
  | 'CONTEXT_BUILD_FAILED'
  | 'ARTIFACT_NOT_FOUND';
```

### 8.2 恢复策略

MVP 恢复只需要：

```text
read run.json
read events.jsonl
read artifacts/*
fold state
tick(run_id)
```

未完成 Activation 的处理：

- `queued`：可重新运行；
- `running`：进程崩溃后视为 failed 或 stale，MVP 标记 failed；
- `waiting_approval`：继续等待；
- `completed`：不重跑。

### 8.3 缓存策略

MVP 可以先不做跨 run cache，只做同 run completed 不重跑。

后续 cache key：

```text
hash(
  target.ref,
  target.version,
  objective,
  context_package.content_hash,
  expected_outputs.schema_id,
  capability.runtime_hints,
  agent_adapter.version
)
```

---

## 九、最小实现顺序

建议按这个顺序落地：

1. 类型定义：`Activation`、`Capability`、`Artifact`、`Event`、`Recipe`、`Policy`。
2. 文件存储：`EventLog`、`ArtifactStore`、`RunStore`。
3. `fold`：从 events/artifacts 构建 `SessionState`。
4. Registry：静态 `AgentRegistry`、`RecipeRegistry`。
5. `ContextBuilder`：支持 task、project_index、explicit artifacts、recent events summary。
6. Mock AgentAdapter：输入 ContextPackage，返回固定 Artifact。
7. `ActivationRunner`：运行 agent target。
8. Deterministic `RecipeRunner`：返回 propose/done/stop。
9. `WorkflowEngine.tick`：串行执行 proposed Activation。
10. `BudgetTracker`：记录 usage，耗尽后 stop。
11. `HumanInterventionManager`：request/respond + waiting 恢复。
12. Recipe target 支持：RecipeActivation 产 directive Artifact。

完成 1-9 就能跑最小 agent workflow；完成 10-12 才具备预算、人审和嵌套编排基础。

---

## 十、MVP 验收用例

### 10.1 单 Agent Run

```text
seed task Artifact
Recipe propose agent Activation
Agent writes role_output Artifact
Recipe done
```

验收：

- events 有 started/requested/started/artifact.written/completed/run.completed；
- fold 后 run completed；
- role_output 可读取。

### 10.2 RecipeActivation

```text
Planner Agent writes workflow_spec
RecipeActivation expand-spec writes directive Artifact
WorkflowEngine executes directive
```

验收：

- 普通 Agent 的 directive 不会被执行；
- RecipeActivation 的 directive 可以被执行。

### 10.3 人工介入

```text
Activation has capability.approval.required
WorkflowEngine tick -> waiting
submitHumanDecision approve
WorkflowEngine tick -> Activation runs
```

验收：

- 写 human_request Artifact；
- 写 human_decision Artifact；
- run 可从 waiting 恢复。

### 10.4 预算停止

```text
policy.max_total_calls = 1
Recipe proposes two Activations
first runs
second rejected/stopped
```

验收：

- budget.charged Event 存在；
- run.stopped reason 是 budget exhausted。

---

## 十一、初版不做的事

明确不进入 MVP：

- 并发执行；
- 强 sandbox；
- 文件读写权限；
- 网络权限；
- provider 真实 token 精确控制；
- 任意 JS workflow DSL；
- 跨 run cache；
- 分布式 worker；
- 完整 UI；
- 自动 schema repair。

这些都可以在 Runtime 稳定后增量加入。

---

## 十二、一句话

初版 Runtime 的核心不是“安全地控制 Agent 的每个动作”，而是：

```text
Recipe 持有编排权
Activation 启动 Agent/Recipe
ContextBuilder 构建输入
Capability 给出轻量启动边界
Artifact/Event 外化状态
Policy 守住编排来源、预算和人审
WorkflowEngine 用 tick 推进 run
```

这套设计已经足够落地一个可恢复、可审计、可人工介入、可逐步扩展的 agent workflow runtime。

