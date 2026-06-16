# agentflow 原语细化设计方案：轻量边界、Agent 承载与 Workflow 框架层

> 生成日期：2026-06-16
> 性质：**设计预览方案**。本文基于 `agentflow-six-primitives.md` 继续细化，但不直接替代正典文档。
> 核心调整：Activation 主要调用 Agent 或 Recipe；Capability 降为轻量运行边界；ContextBuilder 成为框架层核心能力；parallel / pipeline / branch / loop 等放在 Workflow Constructs 层；典型场景只建立在这些框架能力之上。

---

## 一、设计目标

上一版草案把 Capability、Policy、target 类型和事件族设计得过重，容易把框架带向“强安全调度内核”。本轮设计收敛为更适合 agent workflow 的模型：

```text
Primitive Layer        最小语义基底
Runtime Framework      支撑原语运行的框架能力
Workflow Constructs    面向用户/recipe 作者的高层编排 API
Human Intervention     人工介入、裁决、恢复
Standard Agents        可复用的 agent 定义
Scenario Recipes       具体业务流程
```

设计原则：

1. **Agent 承载大多数工作**  
   aggregation、memory、review、planning 都应是 Agent 定义，不是和 Agent 同级的 target 类型。

2. **Recipe 可以被 Activation 调用**  
   `RecipeActivation` 用于受控地产生下一步编排；非 Recipe 类型 Activation 产出的编排必须被拒绝。

3. **Capability 是轻量运行边界**  
   它不管理文件权限、不管理网络权限、不中途打断 Activation、不拦截 Agent 内部工具调用。

4. **Context 是输入构建的核心**  
   Artifact 是 Activation 的持久输出；Agent 的输入由 ContextBuilder 从 task、Artifact、Event、handoff、workflow state 中构建。

5. **Workflow Constructs 补足原语使用面**  
   `parallel`、`pipeline`、`branch`、`loop`、`join`、`context` 不是原语，但应是一等框架能力。

6. **人工介入是一等 workflow 能力，但不是新原语**  
   人工介入通过 request、decision Artifact、Event 和 Recipe branch 表达。

7. **从框架能力再到典型场景**  
   不直接从原语跳到 Planner/Generator/Evaluator，而是先定义 runtime 和 workflow constructs。

---

## 二、分层模型

### 2.1 Primitive Layer

保留六原语，但重新收窄职责：

| 原语 | 职责 |
| --- | --- |
| **Activation** | 一次受控调用，目标只能是 Agent 或 Recipe |
| **Capability** | 启动前的轻量运行边界 |
| **Artifact** | Activation 的持久输出工件 |
| **Event** | append-only 事实流 |
| **Recipe** | 读状态、产生下一步编排的规则 |
| **Policy** | 编排级轻量裁决：谁能编排、预算是否耗尽、是否需要确认 |

> Agent 不作为原语，但在框架层是一等定义。Activation 通过 `target` 指向 Agent 或 Recipe。

### 2.2 Runtime Framework

Runtime Framework 是原语能跑起来所需的框架能力，不是新增原语：

| 能力 | 职责 |
| --- | --- |
| AgentRegistry | 注册 Agent 定义 |
| RecipeRegistry | 注册 Recipe 定义 |
| ContextBuilder | 为 Agent/Recipe 调用构建输入上下文 |
| ActivationRunner | 启动 Activation，调用 Agent CLI 或 Recipe |
| RecipeRunner | 执行 Recipe decide/expand |
| ArtifactStore | 存储和读取 Artifact |
| EventLog | 追加和读取 Event |
| BudgetTracker | 记录 token/call/wall time 使用 |
| HumanInterventionManager | 创建人工请求、等待响应、写入裁决 Artifact |
| WorkflowEngine | 执行 workflow constructs 并 lower 成 Activation |

这些能力可以在实现中是模块、类、服务或库，但不应成为原语。

### 2.3 Workflow Constructs

Workflow Constructs 是给 recipe 作者使用的高层 API：

```text
agent()
recipe()
parallel()
pipeline()
branch()
loop()
join()
context()
writeArtifact()
emit()
requestHuman()
waitForHuman()
```

它们最终都会落到六原语：

```text
construct
  -> Recipe state transition
  -> Activation proposal(s)
  -> Activation output Artifact
  -> EventLog
```

### 2.4 Human Intervention Layer

人工介入是 Runtime/Workflow 层的一等能力，不是第七个原语。

它解决：

```text
需要用户确认是否继续
多个方案需要用户选择
reviewer 分歧需要人类裁决
预算、范围或目标变化需要用户重新授权
workflow 需要暂停等待外部判断
```

原语层落点：

| 人工介入概念 | 原语落点 |
| --- | --- |
| 请求人工介入 | `approval.requested` Event + `human_request` Artifact |
| 等待人工响应 | WorkflowState 中的 waiting 状态 |
| 人工裁决 | `human_decision` Artifact |
| 响应事实 | `human.responded` Event |
| 后续流程变化 | Recipe 读 state 后 branch |
| 启动前确认 | `Capability.approval.required` |

### 2.5 Standard Agents

aggregation、memory 等作为标准 Agent 提供：

| 标准 Agent | 用途 |
| --- | --- |
| `planner.*` | 产 plan / workflow spec / unit list |
| `generator.*` | 实现或修改 |
| `evaluator.*` | 评估结果 |
| `reviewer.*` | 独立审查 |
| `aggregator.*` | 汇总、投票、去重 |
| `memory.summarizer` | 压缩上下文、生成 handoff |
| `critic.*` | 找遗漏、反驳、检查完整性 |

它们只是 Agent 定义，不改变原语。

### 2.6 Scenario Recipes

典型场景在最上层：

```text
long-running-app-dev
review-changes
bug-hunt
code-migration
frontend-qa
loop-polling
```

这些场景只组合 Workflow Constructs 和 Standard Agents。

---

## 三、原语重新定义

### 3.1 Activation

Activation 是一次受控调用。它不再枚举 `system`、`polling`、`aggregation`、`memory` 等 target 类型。

```ts
interface Activation {
  id: string;
  run_id: string;

  target: ActivationTarget;
  objective: ActivationObjective;

  context_request: ContextRequest;
  expected_outputs: ExpectedOutput[];

  capability?: Capability;

  parent_activation_id?: string;
  metadata?: ActivationMetadata;
}

type ActivationTarget =
  | { kind: 'agent'; ref: string; version?: string }
  | { kind: 'recipe'; ref: string; version?: string };
```

字段说明：

| 字段 | 含义 |
| --- | --- |
| `target.kind='agent'` | 调用一个 Agent 定义 |
| `target.kind='recipe'` | 调用一个 Recipe，使其产生下一步编排 |
| `objective` | 本次调用目标 |
| `context_request` | 请求 ContextBuilder 组装什么输入 |
| `expected_outputs` | 期望 Artifact 输出 |
| `capability` | 本次轻量运行边界 |
| `parent_activation_id` | 层次关系，支持嵌套和 plan 展开 |
| `metadata` | phase、group、priority、loop id 等非语义字段 |

不再作为 Activation target 的内容：

| 旧概念 | 新归属 |
| --- | --- |
| `system` | Agent 内部自然动作，或 runtime 自动动作 |
| `polling` | 外部 Event + Recipe loop |
| `aggregation` | `aggregator.*` Agent |
| `memory` | `memory.summarizer` Agent |
| `human` | 可先作为 `approval` 机制；如需人类执行，可建 `human.*` Agent |

#### RecipeActivation

Recipe 值得作为 Activation target，因为它是“受控地产生编排”的唯一入口。

```ts
interface RecipeActivation extends Activation {
  target: { kind: 'recipe'; ref: string; version?: string };
  expected_outputs: [
    {
      kind: 'directive';
      schema_id: 'agentflow.schema.directive.v1';
      ref: string;
    }
  ];
}
```

关键规则：

```text
只有 RecipeActivation 的输出可以被解释为 Directive。
AgentActivation 可以产 plan/workflow_spec Artifact，但不能直接调度。
Agent 产出的 plan 必须由 RecipeActivation 或 RecipeRunner 读取、校验、展开。
```

这样可以同时支持：

- 人工/代码编排；
- Planner 产受限 workflow spec；
- 多层嵌套编排；
- 动态 workflow，但不让普通 Agent 直接获得控制权。

### 3.2 Agent Definition

Agent 不是原语，但它是框架层的一等定义。

```ts
interface AgentDefinition {
  ref: string;
  version: string;

  role: string;
  adapter: AgentAdapterRef;

  default_context?: ContextPolicy;
  output_modes?: OutputMode[];
  default_capability?: Partial<Capability>;

  description?: string;
}
```

Agent 可以是 LLM agent、CLI agent、本地脚本、人类代理入口或混合执行器。原语层不区分它们。

Agent 定义只回答：

```text
这个可调用对象是谁？
如何调用它？
默认希望看到什么上下文？
它能产出什么格式？
```

Agent 内部如何使用工具、读文件、联网、运行命令，不由原语层细管。

### 3.3 Capability

Capability 是轻量运行边界。

它不追求细粒度安全沙箱，也不拦截 Agent 内部每个工具调用；它只回答：

```text
这次 Activation 大致以什么工作模式运行？
可见哪些输入？
最多花多少预算？
启动前是否需要人工确认？
```

建议字段：

```ts
interface Capability {
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
  };
}

interface VisibleInputs {
  artifacts?: string[];
  include_task?: boolean;
  include_project_index?: boolean;
  include_recent_events?: boolean;
  include_previous_outputs?: boolean;
  include_handoff_summary?: boolean;
  include_workflow_state?: boolean;
}
```

明确不属于 Capability 的内容：

| 不属于 Capability | 说明 |
| --- | --- |
| 文件读写权限 | 原语层不管理 |
| 网络权限 | 原语层不管理 |
| 工具级权限拦截 | 由 Agent/CLI/运行环境自行处理 |
| 中途打断 Activation | Runner 工程能力，不是 Capability 语义 |
| destructive operation gate | 不进入轻量原语层 |
| credential vault | 实现层能力 |

预算语义：

```text
启动前：Runtime 检查是否大致还有预算启动。
运行中：Agent/CLI best-effort 控制消耗。
完成后：Runtime 记录实际消耗。
耗尽后：Policy 停止后续 Activation。
```

Capability 的作用不是强安全，而是让 ContextBuilder、Agent adapter 和 BudgetTracker 有共同输入。

### 3.4 Artifact

Artifact 是 Activation 的持久输出工件。

它不是“所有输入”的同义词。输入由 ContextBuilder 构建，Artifact 是可被后续引用的稳定结果。

```ts
interface Artifact<T = unknown> {
  ref: string;
  run_id: string;

  kind: ArtifactKind;
  schema_id: string;
  content_hash: string;

  producer_activation_id: string;
  payload?: T;

  views?: {
    markdown?: string;
    summary?: string;
    diff?: string;
  };

  metadata?: Record<string, unknown>;
}
```

常见 `kind`：

```ts
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
```

关键规则：

- Activation 的稳定输出必须写 Artifact。
- Agent 内部临时上下文不是 Artifact。
- Agent CLI 可以负责输出格式、schema repair 和 structured output。
- 框架只要求最终结果以 Artifact 形式落地。

### 3.5 Event

Event 是 append-only 事实流。

```ts
interface Event {
  seq: number;
  run_id: string;
  type: EventType;

  activation_id?: string;
  artifact_ref?: string;

  payload?: Record<string, unknown>;
}
```

事件类型保持轻量：

```text
run.started
run.completed
run.stopped

activation.requested
activation.started
activation.completed
activation.failed

artifact.written

recipe.directive_recorded
policy.rejected
policy.stopped

budget.charged
approval.requested
approval.granted
approval.rejected
human.responded

external.wakeup
progress.logged
phase.started
phase.completed
```

Event 用于恢复、审计、UI 和预算记录，但不是全量 trace。

### 3.6 Recipe

Recipe 是编排规则。它读取 workflow state，产生 Directive。

```ts
interface RecipeDefinition {
  ref: string;
  version: string;

  mode: 'deterministic' | 'interpreted_spec' | 'recipe_agent';

  input_contract?: string[];
  output_contract?: string[];

  limits?: {
    max_loop_depth?: number;
    max_activations?: number;
  };
}
```

Directive：

```ts
type Directive =
  | { kind: 'propose'; activations: Activation[] }
  | { kind: 'done'; result_artifact?: string }
  | { kind: 'stop'; reason: string };
```

Recipe 可以有三种来源：

| 类型 | 说明 |
| --- | --- |
| `deterministic` | 代码写死的 recipe |
| `interpreted_spec` | 解释 workflow_spec Artifact |
| `recipe_agent` | 通过 RecipeActivation 调用某个 recipe agent 产 Directive |

关键规则：

```text
Recipe 可以编排。
RecipeActivation 可以产 Directive。
普通 AgentActivation 不可以产可执行 Directive。
普通 AgentActivation 只能产 plan/workflow_spec Artifact。
```

### 3.7 Policy

Policy 降为轻量编排裁决，不做强安全。

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
```

Policy 只做这些事：

| 裁决 | 说明 |
| --- | --- |
| 拒绝非 RecipeActivation 产出的 Directive | 防止普通 Agent 直接获得编排权 |
| 预算耗尽后停止后续调度 | 不负责中途强杀 |
| loop/activation/recipe depth 超限后停止 | 防止无限扩张 |
| Capability 要求 approval 时先暂停启动 | 轻量人工确认 |
| 人工裁决返回 stop/reject 时停止或跳过 | Recipe 根据 human_decision 分支 |

不再做：

- 文件路径风险分析；
- 网络权限拦截；
- 工具调用拦截；
- 高危操作审批；
- 每个内部步骤的安全管控。

---

## 四、Runtime Framework 设计

### 4.1 ContextBuilder

ContextBuilder 是本轮设计最重要的框架层能力之一。它负责把 workflow state 变成 Agent/Recipe 可消费的输入包。

```ts
interface ContextRequest {
  mode:
    | 'minimal'
    | 'task'
    | 'implementation'
    | 'review'
    | 'aggregation'
    | 'memory'
    | 'recipe';

  artifacts?: string[];
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
```

输出：

```ts
interface ContextPackage {
  ref: string;
  sections: ContextSection[];
  source_artifacts: string[];
  source_events?: number[];
  estimated_tokens?: number;
}
```

ContextBuilder 输入来源：

| 来源 | 用途 |
| --- | --- |
| task | 用户目标 |
| project_index | 项目结构和约束 |
| selected Artifact | contract、planner_package、change_package、verdict |
| recent Event | 进度、失败、预算状态 |
| previous outputs | 上一轮结果 |
| handoff summary | 上下文重置后的轻量交接 |
| workflow state | loop 计数、分支状态、unit 状态 |

ContextBuilder 可以把输入包写成 `context_package` Artifact，便于审计和复用。但这不是必须的；只有需要稳定引用或调试时才落盘。

### 4.2 ActivationRunner

ActivationRunner 执行 Activation：

```text
1. 读取 Activation
2. Policy 做启动前轻量检查
3. ContextBuilder 构建输入
4. 调用 Agent CLI 或 RecipeRunner
5. 接收输出
6. 写 Artifact
7. 追加 Event
8. BudgetTracker 记录消耗
```

ActivationRunner 不拦截 Agent 内部每个工具调用。

### 4.3 Agent CLI / Adapter

Agent CLI 负责实际执行能力：

| 能力 | 归属 |
| --- | --- |
| 调模型 | Agent CLI / adapter |
| 工具调用 | Agent CLI / adapter |
| 结构化输出 | Agent CLI / adapter |
| schema repair | Agent CLI / adapter |
| 读写工作区 | Agent CLI / adapter |
| 最终输出 Artifact payload | Agent CLI / adapter 返回给 runtime |

Runtime 只定义边界：

```text
输入：ContextPackage + objective + expected_outputs + runtime_hints
输出：Artifact payload(s) + usage + status
```

### 4.4 RecipeRunner

RecipeRunner 负责运行 Recipe：

```text
RecipeRunner(state) -> Directive
```

对 `interpreted_spec`：

```text
workflow_spec Artifact
  -> validate
  -> interpret constructs
  -> produce Directive
```

对 `recipe_agent`：

```text
RecipeActivation
  -> context(mode='recipe')
  -> recipe agent outputs directive Artifact
  -> validate directive
  -> produce Directive
```

### 4.5 BudgetTracker

BudgetTracker 不负责中途打断。它只负责记录与后续停止：

```text
before activation:
  check budget likely available

after activation:
  record actual usage
  emit budget.charged

next scheduling:
  Policy stops if budget exhausted
```

### 4.6 HumanInterventionManager

HumanInterventionManager 负责把“需要人判断”变成可恢复的 workflow 状态。

它不直接改变 Agent 内部执行，也不中途打断正在运行的 Activation。它只在调度边界工作：

```text
1. 创建 human_request Artifact
2. 追加 approval.requested Event
3. 将当前 branch 标记为 waiting_for_human
4. 等待外部输入
5. 写 human_decision Artifact
6. 追加 human.responded Event
7. 唤醒 Recipe 重新 decide
```

建议 Artifact：

```ts
interface HumanRequest {
  kind: 'human_request';
  question: string;
  options?: HumanOption[];
  context_refs: string[];
  requested_by_activation_id?: string;
}

interface HumanDecision {
  kind: 'human_decision';
  request_ref: string;
  decision: 'approve' | 'reject' | 'choose' | 'revise' | 'stop';
  selected_option?: string;
  notes?: string;
  requested_changes?: string;
}
```

人工介入的关键语义：

- 它暂停的是 workflow branch，不是强杀当前 Agent。
- 它产生的是 Artifact/Event，不是隐式状态。
- Recipe 必须显式读取 `human_decision` 后决定下一步。
- 如果用户长时间不响应，Runtime 可以保持 waiting、超时 stop，或让 Recipe 走 fallback 分支。

---

## 五、Workflow Constructs

Workflow Constructs 是比原语更高一层的使用面。

### 5.1 agent()

```ts
const out = await agent('implement auth refresh', {
  role: 'generator.implementer',
  context: {
    mode: 'implementation',
    artifacts: ['planner_package', 'contract/auth-refresh'],
    include: { project_index: true, handoff_summary: true }
  },
  output: {
    kind: 'change_package',
    schema: 'agentflow.schema.change_package.v1'
  },
  capability: {
    work_mode: 'execute',
    budget: { max_tokens: 80000 }
  }
});
```

lower 成：

```text
Activation(target=agent:generator.implementer)
  -> ContextBuilder
  -> Agent CLI
  -> Artifact(change_package)
```

### 5.2 recipe()

```ts
const directive = await recipe('expand-planner-spec', {
  spec: 'planner/workflow_spec.json'
});
```

lower 成：

```text
Activation(target=recipe:expand-planner-spec)
  -> Directive Artifact
  -> Policy 验证来源
  -> WorkflowEngine 调度
```

### 5.3 parallel()

```ts
const outputs = await parallel(
  units.map((unit) => () => agent(`implement ${unit.ref}`, ...)),
  { concurrency: 4 }
);
```

语义：

- 一次 propose 多个 Activation；
- concurrency 是 workflow/runtime 提示；
- 不涉及 Capability 细粒度权限；
- join 前需要等待全部完成。

### 5.4 pipeline()

```ts
await pipeline(
  units,
  (unit) => agent(`analyze ${unit.ref}`, ...),
  (analysis) => agent(`verify ${analysis.ref}`, ...)
);
```

语义：

- 每个 item 独立推进；
- item A 可以进入 stage 2，item B 仍在 stage 1；
- 由 Artifact 就绪驱动下一阶段。

### 5.5 branch()

```ts
await branch(verdict.status, {
  pass: () => done(verdict),
  fail: () => agent('fix issues', ...),
  uncertain: () => agent('ask reviewer', { role: 'reviewer.correctness' })
});
```

语义：

```text
Recipe 读 Artifact/Event state
  -> 选择一个分支
  -> propose 对应 Activation
```

branch 是 workflow construct，不是原语。

### 5.6 loop()

```ts
await loop({
  until: (state) => state.verdict?.status === 'pass',
  maxIterations: 3,
  body: async () => {
    const change = await agent('implement/fix', ...);
    return agent('evaluate', { input: change });
  }
});
```

语义：

- loop state 进入 workflow state；
- 每一轮产出 Event 和 Artifact；
- Policy 只检查 loop depth / total activation / budget；
- 不做中途打断。

### 5.7 join()

```ts
const merged = await join(outputs, {
  role: 'aggregator.merge_findings',
  schema: 'agentflow.schema.findings.v1'
});
```

join 通常 lower 成 `aggregator.*` Agent Activation。

### 5.8 context()

```ts
const reviewContext = context({
  mode: 'review',
  artifacts: ['change_package', 'contract'],
  include: { project_index: true, recent_events: true }
});
```

context 是对 ContextBuilder 的显式调用。它解决“输入怎么构建”的问题。

### 5.9 requestHuman() / waitForHuman()

```ts
const decision = await requestHuman({
  question: 'Evaluator 和 reviewer 结论冲突，是否继续修复？',
  options: [
    { id: 'fix', label: '继续修复' },
    { id: 'accept', label: '接受当前结果' },
    { id: 'stop', label: '停止 workflow' }
  ],
  context: context({
    mode: 'review',
    artifacts: ['verdict/latest', 'review_panel/summary'],
    include: { recent_events: true }
  })
});
```

语义：

```text
requestHuman()
  -> write human_request Artifact
  -> emit approval.requested
  -> pause current branch

human response
  -> write human_decision Artifact
  -> emit human.responded
  -> Recipe reads decision and branches
```

`waitForHuman()` 是底层等待构造；大多数 recipe 作者只需要 `requestHuman()`。

---

## 六、编排权限规则

本设计只保留最小编排安全：

### 6.1 普通 Agent 不能直接编排

```text
AgentActivation output:
  plan Artifact               allowed
  workflow_spec Artifact      allowed
  directive Artifact          ignored or rejected
```

普通 Agent 可以建议下一步，但不能直接调度下一步。

### 6.2 Recipe / RecipeActivation 可以编排

```text
Recipe output:
  Directive                   allowed

RecipeActivation output:
  Directive Artifact          allowed after schema validation
```

### 6.3 Planner 的正确用法

```text
Planner Agent
  -> workflow_spec Artifact

RecipeActivation(expand workflow_spec)
  -> Directive

Policy
  -> accepts because source is RecipeActivation
```

这保留动态能力，但控制流仍由 Recipe 入口负责。

---

## 七、人工介入设计

人工介入是关键 workflow 能力。它不是原语，但必须在框架层明确支持，否则长任务无法可靠处理范围确认、质量分歧、预算选择和用户裁决。

### 7.1 触发入口

人工介入可以由三类入口触发：

| 入口 | 表达 |
| --- | --- |
| 启动前确认 | `Capability.approval.required` |
| Recipe 主动请求 | `requestHuman()` construct |
| Policy 轻量暂停 | 预算、loop、approval 条件触发 waiting |

示例：

```ts
await agent('apply generated change', {
  role: 'generator.implementer',
  capability: {
    work_mode: 'execute',
    approval: {
      required: true,
      reason: '即将进入实现阶段，需要用户确认范围',
      prompt: '是否允许开始修改代码？'
    }
  }
});
```

### 7.2 状态流转

人工介入的状态流：

```text
running
  -> approval.requested
  -> waiting_for_human
  -> human.responded
  -> recipe.decide
  -> continue / revise / choose / stop
```

它暂停的是当前 workflow branch，而不是整个 runtime。其它不依赖该裁决的 branch 可以继续运行。

### 7.3 Artifact 与 Event

人工请求和裁决必须显式落盘：

```text
Artifact(kind='human_request')
Event(type='approval.requested')

Artifact(kind='human_decision')
Event(type='human.responded')
```

`human_decision` 的最小结构：

```ts
interface HumanDecision {
  decision: 'approve' | 'reject' | 'choose' | 'revise' | 'stop';
  selected_option?: string;
  notes?: string;
  requested_changes?: string;
}
```

### 7.4 Recipe 如何继续

Recipe 只读 `human_decision` 后推进：

```ts
await branch(humanDecision.decision, {
  approve: () => resumePendingActivation(),
  reject: () => skipPendingActivation(),
  choose: () => runSelectedOption(humanDecision.selected_option),
  revise: () => agent('revise plan with human feedback', {
    role: 'planner.reviser',
    context: context({
      mode: 'task',
      artifacts: ['human_decision', 'planner_package']
    })
  }),
  stop: () => stop('Stopped by human decision')
});
```

### 7.5 原语层归属

| 概念 | 归属 |
| --- | --- |
| 人工介入能力 | Workflow/Runtime 层 |
| 启动前确认声明 | `Capability.approval` 字段 |
| 请求事实 | `Event` |
| 裁决内容 | `Artifact` |
| 流程变化 | `Recipe` 分支 |
| 是否继续调度 | `Policy` 轻量检查 |
| 人类执行复杂任务 | 可选 `human.*` Agent |

结论：

```text
人工介入不是新原语。
但它是一等 workflow construct 和 runtime 状态。
```

---

## 八、分支与循环能力

Workflow 必须一等支持分支和循环。

### 8.1 分支

分支来源：

- evaluator verdict；
- planner risk classification；
- user approval；
- external wakeup state；
- budget remaining；
- loop iteration count。

表达：

```text
Recipe reads state
if condition:
  propose Activation A
else:
  propose Activation B
```

所有分支条件必须来自 Artifact/Event/WorkflowState，而不是临时模型上下文。

### 8.2 循环

循环类型：

| 类型 | 表达 |
| --- | --- |
| fix-until-pass | evaluator verdict 决定是否继续 |
| loop-until-dry | findings 数量或连续空轮数决定是否继续 |
| polling loop | external.wakeup Event 驱动下一轮 |
| review refinement | reviewer critique 决定是否再生成 |

循环限制：

```text
max_iterations
max_activations
max_total_tokens
max_recipe_depth
```

限制由 Policy 在调度下一步前检查。

---

## 九、其它文档问题的重新覆盖

| 问题 | 新设计表达 |
| --- | --- |
| M13 真实 Planner | `agent(planner.initial)` 产 `planner_package` Artifact；Recipe 读取后展开 generator/evaluator |
| Planner 内部多角色 | planner recipe 使用 `parallel()` 调多个 planner Agent，再用 `aggregator.planner` 汇总 |
| Claude `agent()` | Workflow construct，lower 成 Agent Activation |
| Claude `parallel()` | Workflow construct，一次 propose 多个 Agent Activation |
| Claude `pipeline()` | Workflow construct，由 Artifact 就绪推进 item stage |
| Claude `phase/log` | Event + metadata |
| Claude cache/resume | Runtime 基于 Activation 输入、Agent 版本、输出 schema、ContextPackage hash 做缓存 |
| `/loop` | external.wakeup Event + `loop()` construct |
| managed agents session | EventLog + ArtifactStore 的 run view |
| managed agents harness | Runtime Framework + Workflow Constructs |
| managed agents sandbox/hands | Agent CLI/运行环境能力，原语层不强管 |
| context reset/handoff | `memory.summarizer` 产 handoff Artifact，下一 Activation 的 ContextBuilder 引入 |
| aggregation | `aggregator.*` Agent |
| memory | `memory.summarizer` Agent + context/handoff Artifact |
| polling | external Event + loop，不设 polling target |
| system action | Agent 内部自然执行，或 runtime 自动动作 |
| 人工介入 | `requestHuman()` / `Capability.approval` + human_request/human_decision Artifact + Event |
| review panel | `parallel()` 多个 reviewer Agent + `join()` aggregator Agent |
| adversarial verify | reviewer/critic/adversary Agent 组合 |
| contract negotiation | loop + generator/evaluator/planner contract Artifacts |
| branch | `branch()` construct |
| loop | `loop()` construct |

结论：

```text
其它文档中的问题仍能覆盖。
变化是：不再把每个能力都压进原语字段，而是通过 Runtime Framework 和 Workflow Constructs 承接。
```

---

## 十、端到端预览：Long-running App Dev

### 10.1 Planner

```ts
const plan = await agent('plan task', {
  role: 'planner.initial',
  context: context({
    mode: 'task',
    include: { task: true, project_index: true }
  }),
  output: {
    kind: 'planner_package',
    schema: 'agentflow.schema.planner_package.v1'
  },
  capability: {
    work_mode: 'plan',
    budget: { max_tokens: 40000 }
  }
});
```

### 10.2 Generator / Evaluator Loop

```ts
await pipeline(plan.units,
  async (unit) => loop({
    maxIterations: unit.max_fix_rounds + 1,
    body: async (state) => {
      const change = await agent('implement or fix unit', {
        role: state.iteration === 0
          ? 'generator.implementer'
          : 'generator.fixer',
        context: context({
          mode: 'implementation',
          artifacts: [plan.ref, unit.contract_ref, state.last_verdict_ref].filter(Boolean),
          include: { project_index: true, handoff_summary: true }
        }),
        output: { kind: 'change_package', schema: CHANGE_PACKAGE }
      });

      const verdict = await agent('evaluate unit', {
        role: 'evaluator.initial',
        context: context({
          mode: 'review',
          artifacts: [change.ref, unit.contract_ref],
          include: { project_index: true }
        }),
        output: { kind: 'verdict', schema: VERDICT }
      });

      return verdict.status === 'pass'
        ? done(verdict)
        : continueLoop({ last_verdict_ref: verdict.ref });
    }
  })
);
```

### 10.3 Optional Escalation

```ts
await branch(currentUnit.status, {
  pass: () => done(currentUnit),
  fail_after_retries: () => parallel([
    () => agent('security review', { role: 'reviewer.security' }),
    () => agent('correctness review', { role: 'reviewer.correctness' }),
    () => agent('adversarial critique', { role: 'critic.adversary' })
  ]).then((reviews) =>
    join(reviews, { role: 'aggregator.review_panel' })
  )
});
```

这只是场景层代码；底层仍是：

```text
Recipe -> Activation -> ContextBuilder -> Agent -> Artifact/Event -> Recipe
```

---

## 十一、需要同步到 HTML 预览的结构

HTML 预览应突出：

1. 分层模型：Primitive / Runtime / Workflow / Human Intervention / Standard Agents / Scenario。
2. Activation target 只保留 Agent / Recipe。
3. Capability-lite 的四个问题：
   - 工作模式是什么？
   - 可见哪些输入？
   - 最多花多少预算？
   - 启动前是否需要确认？
4. ContextBuilder 作为输入构建核心。
5. Workflow Constructs 支持 branch/loop/parallel/pipeline。
6. 人工介入作为 key workflow ability：request、waiting、decision、resume。
7. aggregation/memory/polling/system 的新归属。

---

## 十二、下一步落地建议

短期：

1. 把本方案做成可浏览 HTML 预览。
2. 回填到 `agentflow-six-primitives.md` 的“字段与交互”章节。
3. 把 Capability 原定义改为轻量运行边界。
4. 增加 `RecipeActivation` 规则。
5. 增加 ContextBuilder 章节。
6. 增加 HumanInterventionManager 与 `requestHuman()` 章节。

中期：

1. 定义 workflow constructs 的 TS facade。
2. 定义 Activation lower 规则。
3. 定义 AgentDefinition / RecipeDefinition registry。
4. 定义 Artifact 输出和 Agent CLI contract。

暂不做：

- 强 sandbox 权限系统；
- 工具调用级拦截；
- 文件路径安全 gate；
- 网络权限 gate；
- 完整 DSL 执行器；
- 完整数据库 schema。

---

## 十三、一句话

新设计不是把 agent workflow 做成强安全微内核，而是把它做成：

```text
轻量原语 + Agent 承载 + Recipe 编排权 + ContextBuilder 输入构建 + Workflow Constructs 使用层 + 人工介入恢复点
```

Capability 只定义启动边界，Policy 只守住编排权和预算边界，Agent/CLI 承担实际工作，Workflow Constructs 提供 parallel、pipeline、branch、loop 和人工介入等高级能力。这样既能覆盖其它文档中的问题，也不会把原语层做重。
