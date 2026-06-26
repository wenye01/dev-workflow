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

| 原语             | 职责                          |
| -------------- | --------------------------- |
| **Activation** | 一次受控调用，目标只能是 Agent 或 Recipe |
| **Capability** | 启动前的轻量运行边界                  |
| **Artifact**   | Activation 的持久输出工件          |
| **Event**      | append-only 事实流             |
| **Recipe**     | 读状态、产生下一步编排的规则              |
| **Policy**     | 编排级轻量裁决：谁能编排、预算是否耗尽、是否需要确认  |

> Agent 不作为原语，但在框架层是一等定义。Activation 通过 `target` 指向 Agent 或 Recipe。

### 2.2 Runtime Framework

Runtime Framework 是原语能跑起来所需的框架能力，不是新增原语：

| 能力                       | 职责                                          |
| ------------------------ | ------------------------------------------- |
| AgentRegistry            | 注册 Agent 定义                                 |
| RecipeRegistry           | 注册 Recipe 定义                                |
| ContextBuilder           | 为 Agent/Recipe 调用构建输入上下文                    |
| ActivationRunner         | 启动 Activation，调用 Agent CLI 或 Recipe         |
| RecipeRunner             | 执行 Recipe decide/expand                     |
| ArtifactStore            | 存储和读取 Artifact                              |
| EventLog                 | 追加和读取 Event                                 |
| BudgetTracker            | 记录 token/call/wall time 使用                  |
| HumanInterventionManager | 创建人工请求、等待响应、写入裁决 Artifact                   |
| WorkflowEngine           | 执行 workflow constructs 并 lower 成 Activation |

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

| 人工介入概念 | 原语落点                                                  |
| ------ | ----------------------------------------------------- |
| 请求人工介入 | `approval.requested` Event + `human_request` Artifact |
| 等待人工响应 | WorkflowState 中的 waiting 状态                           |
| 人工裁决   | `human_decision` Artifact                             |
| 响应事实   | `human.responded` Event                               |
| 后续流程变化 | Recipe 读 state 后 branch                               |
| 启动前确认  | `Capability.approval.required`                        |

### 2.5 Standard Agents

aggregation、memory 等作为标准 Agent 提供：

| 标准 Agent            | 用途                                 |
| ------------------- | ---------------------------------- |
| `planner.*`         | 产 plan / workflow spec / unit list |
| `generator.*`       | 实现或修改                              |
| `evaluator.*`       | 评估结果                               |
| `reviewer.*`        | 独立审查                               |
| `aggregator.*`      | 汇总、投票、去重                           |
| `memory.summarizer` | 压缩上下文、生成 handoff                   |
| `critic.*`          | 找遗漏、反驳、检查完整性                       |

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

## 三、原语与 Runtime 总体落地模型

本章不沿着当前代码或旧 runtime 草案做补丁，而是从第二章的分层模型重新推导一个可以落地的实现：

```text
Recipe owns control
  -> proposes Activation
Policy admits or pauses
  -> ActivationRunner executes Agent or Recipe
ContextBuilder builds input
  -> Adapter returns payload
ArtifactStore persists durable output
EventLog records facts
  -> fold(EventLog, ArtifactStore) rebuilds state
  -> Recipe decides next tick
```

这套实现的中心不是一个“万能 Scheduler”，而是一个可重放的 `tick` 循环。每次 tick 只做三件事：

1. 从 Event 和 Artifact 折叠出当前 `RunState`；
2. 让 Recipe 基于 `RunState` 产出下一步 `Directive`；
3. 让 Runtime 在 Policy、Capability、ContextBuilder 和 Runner 的边界内执行这些 Directive。

### 3.1 总体职责边界

| 层                   | 实现对象                                                                       | 负责什么                                 | 不负责什么                      |
| ------------------- | -------------------------------------------------------------------------- | ------------------------------------ | -------------------------- |
| Primitive           | Activation / Capability / Artifact / Event / Recipe / Policy               | 系统状态和控制权的最小语义                        | agent 内部工具细节、UI、分布式 worker |
| Runtime             | Store / Registry / Builder / Runner / Engine                               | 原语的存储、恢复、执行、校验                       | 业务策略本身                     |
| Workflow Constructs | agent / recipe / parallel / pipeline / branch / loop / join / requestHuman | 给 recipe 作者的 API，并 lower 成 Directive | 自己直接执行模型或工具                |
| Agent Adapter       | CLI / local function / mock / remote worker                                | 真正执行 Agent，并返回结构化产物                  | 直接调度下一步 Activation         |

关键边界：

```text
Recipe 可以编排，但不直接执行 Agent。
Agent 可以产出 plan/workflow_spec，但不能直接编排。
Policy 可以拒绝/暂停/停止，但不替业务选择下一步。
Capability 给启动边界，但不做强 sandbox。
ContextBuilder 构建输入，但不创造业务事实。
Artifact/Event 是唯一能影响后续 tick 的持久状态。
```

### 3.2 一次 tick 的端到端交互

MVP 先采用单进程、单 run、串行 runner。并发可以后续加在 queued activation 层，不改变原语。

```text
WorkflowEngine.tick(run_id)
  1. state = StateProjector.fold(run_id)
  2. if state.run.status is terminal: return
  3. recipe = RecipeRegistry.resolve(state.run.recipe_ref)
  4. directive = RecipeRunner.decide(recipe, state)
  5. EventLog.append(recipe.directive_recorded)
  6. verdict = PolicyEngine.evaluateDirective(directive, source=recipe)
  7. if verdict is stop/reject/wait: persist state transition and return
  8. for activation in directive.activations:
       resolved = ActivationFactory.normalize(activation)
       verdict = PolicyEngine.evaluateActivation(resolved, state)
       if approval required:
         HumanInterventionManager.request(resolved)
       if admitted:
         ActivationQueue.enqueue(resolved)
  9. ActivationRunner.drainQueue(run_id)
 10. state = StateProjector.fold(run_id)
 11. if recipe sees completion on next tick, it emits done
```

`tick` 的幂等目标：

- 已经 `completed` 的 Activation 不重跑；
- 已经写入的 Artifact 通过 `content_hash` 可重复验证；
- `running` 状态在进程崩溃后恢复为 `failed_stale` 或重新入队，MVP 选择前者更简单；
- 所有状态变化必须先写 Event，再让下一次 fold 看见。

### 3.3 控制流和数据流

控制流：

```text
RecipeDefinition
  -> RecipeRunner.decide
  -> Directive
  -> PolicyEngine.evaluateDirective
  -> Activation proposals
  -> PolicyEngine.evaluateActivation
  -> ActivationRunner
```

数据流：

```text
seed Artifact / previous Artifact / Event summary / workflow state
  -> ContextBuilder
  -> ContextPackage
  -> AgentAdapter or RecipeActivation adapter
  -> ProducedArtifact[]
  -> ArtifactStore.write
  -> EventLog.append(artifact.written)
```

恢复流：

```text
run.json + events.jsonl + artifacts/*.json
  -> StateProjector.fold
  -> RunState
  -> Recipe can continue without hidden memory
```

### 3.4 原语之间的交互细节

| 交互                           | 落地规则                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| Recipe -> Activation         | Recipe 只能返回 Directive；Directive 中的 Activation 必须经过 normalize 和 Policy gate                 |
| Activation -> Capability     | Activation 可带 override；最终 Capability = Agent/Recipe 默认值 + Recipe 指定值 + Activation override |
| Capability -> ContextBuilder | `visible_inputs` 是硬输入选择提示；`context_request` 是本次调用希望构建的上下文形态                                |
| ContextBuilder -> Artifact   | ContextPackage 默认是内存对象；需要审计、缓存或跨进程传递时才写 `context_package` Artifact                         |
| Activation -> AgentAdapter   | Runtime 只传 ContextPackage、objective、expected_outputs、runtime_hints                         |
| AgentAdapter -> Artifact     | Adapter 返回 ProducedArtifact；Runtime 负责 schema 校验、hash、写 store                              |
| Artifact -> Recipe           | Recipe 只能依赖 schema 校验通过且已写入 Event 的 Artifact                                               |
| Event -> State               | Event 是状态事实；Artifact 是内容事实；fold 必须二者结合                                                     |
| Policy -> HumanIntervention  | approval 或 budget/limit 暂停时写 human_request 或 waiting Event                                 |
| HumanDecision -> Recipe      | 人类响应不直接执行动作，只写 `human_decision`，下一 tick 由 Recipe 分支                                        |

### 3.5 最小运行时组件图

```text
                +---------------------+
                |   WorkflowEngine    |
                +----------+----------+
                           |
         +-----------------+-----------------+
         |                 |                 |
  +------v------+   +------v------+   +------v------+
  | RecipeRunner|   | PolicyEngine|   | StateProjector
  +------+------+   +------+------+   +------+------+
         |                 |                 |
         |                 |                 |
  +------v------+   +------v------+   +------v------+
  |RecipeRegistry|  |BudgetTracker|   | EventLog    |
  +-------------+   +-------------+   +------+------+
                                               |
                                        +------v------+
                                        |ArtifactStore|
                                        +------+------+
                                               |
  +----------------+   +---------------+       |
  |ContextBuilder  +---> ActivationRunner <----+
  +----------------+   +-------+-------+
                               |
                        +------v------+
                        |AgentAdapter |
                        +-------------+
```

### 3.6 MVP 的存储选择

先用文件系统实现，避免数据库设计过早固化：

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
```

写入顺序：

1. `ArtifactStore.write()` 先写临时文件，再原子 rename；
2. `EventLog.append()` 单 writer 追加 JSONL；
3. `StateProjector.fold()` 只信任已经出现在 EventLog 中的 artifact ref；
4. `run.json` 只缓存 run metadata 和最新 status，不作为事实来源。

MVP 不需要分布式锁。只要求同一个 `run_id` 同时只有一个 WorkflowEngine writer。后续如果要多 worker，再把 EventLog append 和 queue claim 替换成数据库事务。

### 3.7 Runtime 状态机

Run 状态：

```text
created
  -> running
  -> waiting
  -> completed
  -> stopped
  -> failed
```

Activation 状态：

```text
proposed
  -> waiting_approval
  -> queued
  -> running
  -> completed
  -> failed
  -> skipped
```

状态只通过 Event 推进：

| Event                         | StateProjector 更新                                         |
| ----------------------------- | --------------------------------------------------------- |
| `run.started`                 | run.status = running                                      |
| `recipe.directive_recorded`   | 记录本轮 recipe 决策                                            |
| `activation.requested`        | activation.status = proposed                              |
| `activation.waiting_approval` | activation.status = waiting_approval，run.status = waiting |
| `activation.queued`           | activation.status = queued                                |
| `activation.started`          | activation.status = running                               |
| `artifact.written`            | artifact ref 对当前 state 可见                                 |
| `activation.completed`        | activation.status = completed，记录 usage                    |
| `activation.failed`           | activation.status = failed，记录 error                       |
| `budget.charged`              | budget 累加                                                 |
| `human.responded`             | waiting request resolved                                  |
| `run.completed`               | run.status = completed                                    |
| `run.stopped`                 | run.status = stopped                                      |

### 3.8 总体验收目标

这套设计第一阶段完成后，应能跑通四个场景：

1. 单 Agent：seed task -> recipe propose agent -> role_output Artifact -> done；
2. Planner 展开：planner agent 产 workflow_spec -> RecipeActivation 展开 -> generator agent 执行；
3. 人工确认：activation approval required -> waiting -> human_decision approve -> resume；
4. 预算停止：policy calls/tokens 耗尽 -> 后续 activation 不再启动 -> run.stopped。

## 四、逐模块落地设计：原语与 Runtime

本章按实现模块展开。每个模块都说明：数据结构、写入规则、读取规则、失败处理和 MVP 边界。

### 4.1 共享类型与命名

```ts
type RunId = string;
type ActivationId = string;
type ArtifactRef = string;
type SchemaId = string;
type AgentRef = string;
type RecipeRef = string;

interface Usage {
  tokens_input?: number;
  tokens_output?: number;
  tokens_total?: number;
  calls?: number;
  wall_time_ms?: number;
}

interface RuntimeError {
  code:
    | 'AGENT_NOT_FOUND'
    | 'RECIPE_NOT_FOUND'
    | 'ARTIFACT_NOT_FOUND'
    | 'SCHEMA_VALIDATION_FAILED'
    | 'DIRECTIVE_REJECTED'
    | 'BUDGET_EXHAUSTED'
    | 'APPROVAL_REJECTED'
    | 'CONTEXT_BUILD_FAILED'
    | 'ADAPTER_FAILED';
  message: string;
  details?: Record<string, unknown>;
}
```

命名约定：

- `ref` 是业务稳定名，例如 `planner/package`；
- `id` 是运行时唯一实例，例如 `act_01H...`；
- `schema_id` 必须版本化，例如 `agentflow.directive.v1`；
- `content_hash` 用 canonical JSON 计算；
- 文件名只使用 escaped ref，不让 ref 直接成为路径。

### 4.2 Activation 模块

Activation 是 Runtime 唯一能启动的执行单元。

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
  created_by: ActivationCreator;
  metadata?: ActivationMetadata;
}

type ActivationTarget =
  | { kind: 'agent'; ref: AgentRef; version?: string }
  | { kind: 'recipe'; ref: RecipeRef; version?: string };

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
```

构造规则：

1. Recipe 返回的 Activation 可以省略 `id`，由 `ActivationFactory` 补齐；
2. `run_id` 必须与当前 run 一致；
3. `created_by` 必须可追溯到当前 recipe 或 recipe activation；
4. `target.kind='recipe'` 的 Activation 只能声明一个 `directive` 输出；
5. `target.kind='agent'` 即使返回 directive payload，Runtime 也只按普通 Artifact 保存，不解释为控制流。

落地接口：

```ts
interface ActivationStore {
  put(activation: Activation): Promise<void>;
  get(run_id: RunId, id: ActivationId): Promise<Activation | undefined>;
  list(run_id: RunId): Promise<Activation[]>;
}
```

MVP 可以把 activation spec 同时写入 `activations/<id>.json`，并在 EventLog 中追加 `activation.requested`。恢复时如果 Event 存在但 spec 文件不存在，视为 runtime corruption，run 进入 failed。

### 4.3 Capability 模块

Capability 是轻量启动边界，不是权限微内核。

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
```

合并顺序：

```text
AgentDefinition.default_capability
  <- Recipe supplied capability
  <- Activation capability override
```

合并规则：

- 标量字段后者覆盖前者；
- `visible_inputs.artifacts` 取并集，但 activation override 可以用空数组表达“只看显式 context_request”；
- `budget` 取更严格值，避免上层无意放大 agent 默认预算；
- `approval.required` 只要任一层为 true 就需要确认；
- `runtime_hints` 后者覆盖前者。

Runtime 使用点：

| 使用方            | 使用方式                                         |
| -------------- | -------------------------------------------- |
| PolicyEngine   | 检查预算和 approval                               |
| ContextBuilder | 结合 `visible_inputs` 和 `context_request` 选择输入 |
| AgentAdapter   | 接收 model/output_format/temperature 等 hints   |
| BudgetTracker  | 记录本次 activation 的 usage 上限和实际消耗              |

明确不做：

- 不限制文件路径；
- 不拦截网络；
- 不拦截工具调用；
- 不中途强杀 Agent；
- 不管理 credential。

### 4.4 Artifact 模块

Artifact 是跨 activation 的唯一持久输出。

```ts
interface Artifact<T = unknown> {
  ref: ArtifactRef;
  run_id: RunId;
  kind: ArtifactKind;
  schema_id: SchemaId;
  content_hash: string;
  producer_activation_id?: ActivationId;
  payload?: T;
  storage_uri?: string;
  views?: {
    markdown?: string;
    summary?: string;
    diff?: string;
  };
  metadata?: Record<string, unknown>;
}
```

MVP 的 `ArtifactKind`：

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

写入流程：

```text
ProducedArtifact
  -> SchemaRegistry.validate(schema_id, payload)
  -> canonicalize payload
  -> compute content_hash
  -> write artifacts/<safe_ref>.json
  -> append artifact.written
```

读取规则：

- Recipe 只能读取 `artifact.written` Event 已出现的 Artifact；
- `ref` 默认指向最新版本；
- Event payload 可以记录 `content_hash`，后续可扩展到多版本读取；
- 大 payload 写 `blobs/<hash>.bin`，Artifact 中只留 `storage_uri` 和 summary。

Schema 策略：

1. 内置 schema 必须严格校验；
2. 未知 schema MVP 可配置为 warning，但 recipe/control 相关 schema 必须 strict；
3. `directive`、`human_decision`、`workflow_spec` 属于 control-adjacent artifact，不能跳过校验。

### 4.5 Event 模块

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
```

MVP EventType：

```ts
type EventType =
  | 'run.started'
  | 'run.completed'
  | 'run.stopped'
  | 'run.failed'
  | 'recipe.directive_recorded'
  | 'activation.requested'
  | 'activation.waiting_approval'
  | 'activation.queued'
  | 'activation.started'
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

EventLog 接口：

```ts
interface EventLog {
  append(run_id: RunId, event: Omit<Event, 'seq' | 'recorded_at'>): Promise<Event>;
  list(run_id: RunId, afterSeq?: number): Promise<Event[]>;
}
```

实现要求：

- `seq` 由 EventLog 分配，run 内单调递增；
- append 必须单 writer 原子化；
- Event payload 不存大文本；
- 修改状态只能追加新 Event，不能改旧 Event；
- 测试中必须能从空内存 + EventLog + ArtifactStore 重建 state。

### 4.6 Recipe 模块

Recipe 持有编排权。它读 state，产 Directive。

```ts
interface RecipeDefinition {
  ref: RecipeRef;
  version: string;
  mode: 'deterministic' | 'interpreted_spec' | 'recipe_agent';
  limits?: {
    max_loop_depth?: number;
    max_activations?: number;
    max_recipe_depth?: number;
  };
}

type Directive =
  | { kind: 'propose'; activations: ActivationDraft[] }
  | { kind: 'wait'; reason: string; waiting_for: string[] }
  | { kind: 'done'; result_artifact?: ArtifactRef }
  | { kind: 'stop'; reason: string };

type ActivationDraft = Omit<Activation, 'id' | 'run_id' | 'created_by'> & {
  id?: ActivationId;
  created_by?: ActivationCreator;
};
```

三种 Recipe：

| mode               | MVP 实现                                  | 适用场景                 |
| ------------------ | --------------------------------------- | -------------------- |
| `deterministic`    | TypeScript 函数                           | 固定流程、单测友好            |
| `interpreted_spec` | 解释 `workflow_spec` Artifact             | Planner 产 spec 后受控展开 |
| `recipe_agent`     | RecipeActivation 调用特殊 agent 产 directive | 后续支持动态编排             |

RecipeRuntime：

```ts
interface RecipeRuntime {
  decide(state: RunState, api: WorkflowConstructApi): Promise<Directive>;
}
```

不变量：

- `decide` 不直接调用 AgentAdapter；
- Workflow constructs 只创建 ActivationDraft 或 Directive；
- Directive 必须写入 `recipe.directive_recorded` Event；
- `recipe_agent` 产出的 directive 必须由 `target.kind='recipe'` 的 Activation 产生。

### 4.7 Policy 模块

Policy 是轻量裁决，不做业务编排。

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
  | { kind: 'wait_approval'; request: HumanRequestDraft }
  | { kind: 'reject'; reason: string }
  | { kind: 'stop'; reason: string };
```

PolicyEngine：

```ts
interface PolicyEngine {
  evaluateDirective(input: {
    policy: Policy;
    state: RunState;
    directive: Directive;
    source: ActivationCreator;
  }): PolicyVerdict;

  evaluateActivation(input: {
    policy: Policy;
    state: RunState;
    activation: Activation;
    capability?: Capability;
  }): PolicyVerdict;
}
```

规则：

1. `allow_directive_from='recipe_only'`：非 Recipe/RecipeActivation 的 Directive 一律 reject；
2. 总预算耗尽时 stop，不再 admit 新 Activation；
3. `workflow_limits` 超限时 stop；
4. `capability.approval.required=true` 时返回 wait_approval；
5. human_decision 为 reject/stop 时，Policy 不自动补救，由 Recipe 下一 tick 决定替代路径。

### 4.8 ContextBuilder 模块

ContextBuilder 是输入构建核心。

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

interface ContextPackage {
  ref?: ArtifactRef;
  mode: ContextRequest['mode'];
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

构建顺序：

1. 合并 `context_request.artifacts` 和 `capability.visible_inputs.artifacts`；
2. 按 ref 精确读取 Artifact；
3. 根据 include 补入 task、project_index、handoff、previous_outputs；
4. recent_events 只生成摘要；
5. workflow_state 只放必要计数、等待项、当前分支；
6. 根据 `max_tokens` 做裁剪。

裁剪优先级：

```text
recent_events full detail
  -> artifact views.diff
  -> artifact views.markdown
  -> previous_outputs
  -> project_index detail
  -> fail with CONTEXT_BUILD_FAILED
```

ContextPackage 默认不落盘。出现以下任一条件才写 `context_package` Artifact：

- activation metadata 要求审计；
- adapter 需要跨进程读取 context；
- 后续缓存需要 context hash；
- 调试模式开启。

### 4.9 AgentRegistry 与 Adapter 模块

AgentDefinition：

```ts
interface AgentDefinition {
  ref: AgentRef;
  version: string;
  role: string;
  adapter: AgentAdapterRef;
  default_context?: Partial<ContextRequest>;
  default_capability?: Partial<Capability>;
  output_schemas?: ExpectedOutputTemplate[];
  description?: string;
}

interface AgentAdapterRef {
  kind: 'cli' | 'local_function' | 'mock';
  ref: string;
}
```

Adapter contract：

```ts
interface AgentAdapter {
  run(input: AgentRunInput): Promise<AgentRunResult>;
}

interface AgentRunInput {
  activation: Activation;
  agent: AgentDefinition;
  context: ContextPackage;
  expected_outputs: ExpectedOutput[];
  runtime_hints?: Capability['runtime_hints'];
}

interface AgentRunResult {
  status: 'completed' | 'failed';
  outputs?: ProducedArtifact[];
  usage?: Usage;
  error?: RuntimeError;
}

interface ProducedArtifact {
  ref: ArtifactRef;
  kind: ArtifactKind;
  schema_id: SchemaId;
  payload: unknown;
  views?: Artifact['views'];
  metadata?: Record<string, unknown>;
}
```

MVP 至少实现两个 adapter：

1. `mock`：用于 deterministic tests；
2. `local_function` 或 `cli`：用于接入真实 agent runner。

Adapter 不能调用 WorkflowEngine，也不能写 EventLog。它只返回结果，由 Runtime 统一落盘。

### 4.10 ActivationRunner 模块

ActivationRunner 是唯一执行 Activation 的模块。

```ts
interface ActivationRunner {
  run(input: {
    run_id: RunId;
    activation: Activation;
    state: RunState;
  }): Promise<void>;
}
```

执行 agent target：

```text
append activation.started
resolve AgentDefinition
resolve Capability
context = ContextBuilder.build
result = AgentAdapter.run
if result.failed:
  append activation.failed
  return
for output in result.outputs:
  validate + ArtifactStore.write
  append artifact.written
BudgetTracker.charge(result.usage)
append activation.completed
```

执行 recipe target：

```text
append activation.started
context = ContextBuilder.build(mode='recipe')
directive = RecipeRunner.runActivation
validate directive schema
write Artifact(kind='directive')
append artifact.written
append recipe.directive_recorded with source=recipe_activation
append activation.completed
```

RecipeActivation 的 directive 不在 ActivationRunner 内立即执行。下一次 WorkflowEngine.tick 会通过 Event/fold 读取并由 Policy gate，保证执行链可恢复。

失败处理：

- Agent not found -> activation.failed；
- schema failed -> activation.failed，并可写 raw `role_output` debug artifact；
- adapter timeout -> activation.failed；
- budget charge 写入失败 -> run.failed，因为 usage 事实不完整；
- Artifact 写入成功但 Event append 失败 -> 下次 fold 不可见，恢复任务扫描 orphan artifact 并报警。

### 4.11 RecipeRunner 模块

RecipeRunner 有两个入口：

```ts
interface RecipeRunner {
  decide(input: {
    run_id: RunId;
    recipe: RecipeDefinition;
    state: RunState;
  }): Promise<Directive>;

  runActivation(input: {
    activation: Activation;
    recipe: RecipeDefinition;
    context: ContextPackage;
  }): Promise<Directive>;
}
```

`decide` 用于主 recipe tick。`runActivation` 用于 `target.kind='recipe'` 的 Activation。

MVP 实现：

- deterministic：调用注册函数；
- interpreted_spec：读取指定 `workflow_spec` Artifact，解释为 ActivationDraft；
- recipe_agent：接口预留，可以先返回 `RECIPE_NOT_FOUND` 或 feature flag。

interpreted_spec 必须限制 schema：

```ts
interface WorkflowSpec {
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

不允许 workflow_spec 表达任意代码，只允许表达受限 Activation 图。

### 4.12 WorkflowEngine 模块

WorkflowEngine 对外提供最小 API：

```ts
interface WorkflowEngine {
  start(input: StartRunInput): Promise<RunRecord>;
  tick(run_id: RunId): Promise<RunTickResult>;
  submitHumanDecision(input: HumanResponseInput): Promise<void>;
}

interface StartRunInput {
  recipe_ref: RecipeRef;
  seed_artifacts: Array<Omit<Artifact, 'run_id' | 'content_hash'>>;
  policy?: Policy;
}

interface RunTickResult {
  status: 'running' | 'waiting' | 'completed' | 'stopped' | 'failed';
  ran_activations: ActivationId[];
  waiting?: WaitingState[];
}
```

`start`：

1. 创建 run_id；
2. 写 run.json；
3. 写 seed artifacts；
4. append `run.started` 和 seed `artifact.written`；
5. 返回 RunRecord，不自动跑 tick，调用方显式驱动。

`tick`：

```text
state = fold()
if terminal: return
if state has waiting human without response: return waiting
directive = RecipeRunner.decide()
record directive
policy gate directive
normalize activations
policy gate activations
enqueue admitted activations
drain queue serially
fold final state
return status
```

MVP 串行 drain queue。`parallel()` 的语义先表现为“一次 propose 多个 activation”，并发执行是后续 runner 优化。

### 4.13 HumanInterventionManager 模块

人工介入是 runtime 状态，不是第七原语。

```ts
interface HumanRequestDraft {
  question: string;
  options?: HumanOption[];
  context_refs: ArtifactRef[];
  requested_by_activation_id?: ActivationId;
}

interface HumanRequest {
  question: string;
  options?: HumanOption[];
  context_refs: ArtifactRef[];
  requested_by_activation_id?: ActivationId;
}

interface HumanDecision {
  decision: 'approve' | 'reject' | 'choose' | 'revise' | 'stop';
  selected_option?: string;
  notes?: string;
  requested_changes?: string;
}
```

request 流程：

```text
write Artifact(kind='human_request')
append artifact.written
append approval.requested
append activation.waiting_approval
run.status becomes waiting by fold
```

respond 流程：

```text
write Artifact(kind='human_decision')
append artifact.written
append human.responded
if decision approve:
  append approval.granted
else:
  append approval.rejected
next tick lets Recipe decide
```

注意：approve 不直接启动 Activation。下一次 tick 会看到 human_decision，再由 Recipe 或 WorkflowEngine 把 pending activation 重新 queued。这样恢复逻辑更清晰。

### 4.14 BudgetTracker 模块

BudgetTracker 只做记账和启动前判断。

```ts
interface BudgetTracker {
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

规则：

- `canStart` 只基于已记录 usage 判断；
- per-activation budget 是 adapter hint，不承诺强杀；
- `charge` 追加 `budget.charged` Event；
- Policy 在下一次 gate 时根据总预算停止后续调度。

### 4.15 StateProjector 模块

StateProjector 是 fold 实现。

```ts
interface RunState {
  run: RunRecord;
  events: Event[];
  artifacts: Map<ArtifactRef, Artifact>;
  activations: Map<ActivationId, ActivationState>;
  budget: {
    tokens_total: number;
    calls_total: number;
    wall_time_ms_total: number;
  };
  waiting: WaitingState[];
  workflow: {
    loop_counters: Record<string, number>;
    branch_status: Record<string, 'running' | 'waiting' | 'done' | 'skipped'>;
    values: Record<string, unknown>;
  };
}
```

fold 要求：

1. 先读 run.json 得到 policy 和 root recipe；
2. 按 seq 读取 events；
3. 遇到 `artifact.written` 再读 ArtifactStore；
4. 遇到 `activation.requested` 再读 ActivationStore；
5. 不从 adapter 临时输出恢复任何状态；
6. 对缺失 artifact/spec 报 runtime corruption。

### 4.16 Workflow Constructs 的 lower 规则

Construct 不直接执行，只返回 Directive 或 ActivationDraft。

| Construct        | lower 结果                                              |
| ---------------- | ----------------------------------------------------- |
| `agent()`        | 一个 `target.kind='agent'` ActivationDraft              |
| `recipe()`       | 一个 `target.kind='recipe'` ActivationDraft             |
| `parallel()`     | 一个 `Directive.propose`，包含多个独立 ActivationDraft         |
| `pipeline()`     | Recipe 根据已完成 Artifact 在后续 tick 提议下一 stage             |
| `branch()`       | Recipe 根据 Artifact/Event/WorkflowState 选择一个 Directive |
| `loop()`         | Recipe 维护 loop counter，直到 condition 或 limit           |
| `join()`         | 一个 `aggregator.*` Agent ActivationDraft               |
| `context()`      | 只生成 ContextRequest，不构建 ContextPackage                 |
| `requestHuman()` | 写 human_request 的 Directive/wait 分支                   |

这保证 workflow API 足够好用，但控制权仍在 Recipe。

### 4.17 最小实现顺序

落地顺序应按可测试闭环组织：

1. 类型和 schema：Activation、Capability、Artifact、Event、Recipe、Policy；
2. 文件存储：RunStore、EventLog、ArtifactStore、ActivationStore；
3. StateProjector：能从 seed artifacts 和 events fold 出 RunState；
4. Registry：静态 AgentRegistry、RecipeRegistry；
5. Mock AgentAdapter：输入 ContextPackage，输出固定 Artifact；
6. ContextBuilder：支持 task、project_index、explicit artifacts、recent events summary；
7. ActivationRunner：跑 agent target，写 Artifact/Event；
8. deterministic RecipeRunner：返回 propose/done/stop；
9. WorkflowEngine.start/tick：跑通单 Agent；
10. PolicyEngine + BudgetTracker：跑通预算停止；
11. HumanInterventionManager：跑通 waiting/resume；
12. RecipeActivation / interpreted_spec：跑通 planner spec 受控展开。

每一步都必须有验收测试，不等整个系统完成后再测。

### 4.18 必须单测的场景

| 测试                           | 断言                                       |
| ---------------------------- | ---------------------------------------- |
| 单 Agent run                  | Event 顺序完整，role_output 可读，run completed  |
| Agent 产 directive            | Artifact 可保存，但不会被执行                      |
| RecipeActivation 产 directive | schema 通过后下一 tick 可执行                    |
| ContextBuilder 裁剪            | 超 token 时按优先级裁剪或失败                       |
| approval required            | run waiting，写 human_request              |
| human approve                | 写 human_decision，下一 tick resume          |
| budget exhausted             | 后续 activation stop/reject                |
| crash recovery               | 清空内存后 fold 可恢复状态                         |
| stale running                | 进程恢复后 running activation 标记 failed_stale |
| schema failure               | activation failed，不污染 recipe 可读状态        |

### 4.19 落地回查

按第二章原语设计回查：

1. **Activation 仍是一切执行边界**：Agent、Recipe 都只能通过 Activation 启动。
2. **Capability 保持轻量**：它只影响启动、上下文和 hints，没有变成权限系统。
3. **Artifact 是持久输出**：所有影响后续流程的数据都必须写 Artifact。
4. **Event 是事实来源**：状态恢复只依赖 EventLog + ArtifactStore + ActivationStore。
5. **Recipe 独占编排权**：普通 Agent 输出不会直接驱动调度。
6. **Policy 只做裁决**：预算、approval、depth、来源校验清晰，不做业务判断。
7. **ContextBuilder 是输入核心**：输入构建独立于 Artifact 输出和 Agent 内部上下文。
8. **人工介入可恢复**：请求和裁决都是 Artifact/Event，下一 tick 显式继续。
9. **Workflow Constructs 没有越权**：它们只 lower 成 ActivationDraft/Directive。
10. **MVP 可先串行**：并发是 runner 优化，不影响原语和状态模型。

因此，这个方案可以从文件存储和 mock adapter 起步，逐步接入真实 Agent CLI；每一步都有独立验收点，不依赖一次性实现完整 DSL、强 sandbox 或分布式调度。

<details>
<summary>旧版三、四章内容（已由上文独立落地方案替代，保留为迁移参考）</summary>

### 迁移参考 A：原语重新定义（旧版）

#### 旧 3.1 Activation

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

| 字段                     | 含义                                  |
| ---------------------- | ----------------------------------- |
| `target.kind='agent'`  | 调用一个 Agent 定义                       |
| `target.kind='recipe'` | 调用一个 Recipe，使其产生下一步编排               |
| `objective`            | 本次调用目标                              |
| `context_request`      | 请求 ContextBuilder 组装什么输入            |
| `expected_outputs`     | 期望 Artifact 输出                      |
| `capability`           | 本次轻量运行边界                            |
| `parent_activation_id` | 层次关系，支持嵌套和 plan 展开                  |
| `metadata`             | phase、group、priority、loop id 等非语义字段 |

不再作为 Activation target 的内容：

| 旧概念           | 新归属                                          |
| ------------- | -------------------------------------------- |
| `system`      | Agent 内部自然动作，或 runtime 自动动作                  |
| `polling`     | 外部 Event + Recipe loop                       |
| `aggregation` | `aggregator.*` Agent                         |
| `memory`      | `memory.summarizer` Agent                    |
| `human`       | 可先作为 `approval` 机制；如需人类执行，可建 `human.*` Agent |

##### RecipeActivation

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

#### 旧 3.2 Agent Definition

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

#### 旧 3.3 Capability

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

| 不属于 Capability             | 说明                           |
| -------------------------- | ---------------------------- |
| 文件读写权限                     | 原语层不管理                       |
| 网络权限                       | 原语层不管理                       |
| 工具级权限拦截                    | 由 Agent/CLI/运行环境自行处理         |
| 中途打断 Activation            | Runner 工程能力，不是 Capability 语义 |
| destructive operation gate | 不进入轻量原语层                     |
| credential vault           | 实现层能力                        |

预算语义：

```text
启动前：Runtime 检查是否大致还有预算启动。
运行中：Agent/CLI best-effort 控制消耗。
完成后：Runtime 记录实际消耗。
耗尽后：Policy 停止后续 Activation。
```

Capability 的作用不是强安全，而是让 ContextBuilder、Agent adapter 和 BudgetTracker 有共同输入。

#### 旧 3.4 Artifact

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

#### 旧 3.5 Event

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

#### 旧 3.6 Recipe

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

| 类型                 | 说明                                                |
| ------------------ | ------------------------------------------------- |
| `deterministic`    | 代码写死的 recipe                                      |
| `interpreted_spec` | 解释 workflow_spec Artifact                         |
| `recipe_agent`     | 通过 RecipeActivation 调用某个 recipe agent 产 Directive |

关键规则：

```text
Recipe 可以编排。
RecipeActivation 可以产 Directive。
普通 AgentActivation 不可以产可执行 Directive。
普通 AgentActivation 只能产 plan/workflow_spec Artifact。
```

#### 旧 3.7 Policy

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

| 裁决                                 | 说明                          |
| ---------------------------------- | --------------------------- |
| 拒绝非 RecipeActivation 产出的 Directive | 防止普通 Agent 直接获得编排权          |
| 预算耗尽后停止后续调度                        | 不负责中途强杀                     |
| loop/activation/recipe depth 超限后停止 | 防止无限扩张                      |
| Capability 要求 approval 时先暂停启动      | 轻量人工确认                      |
| 人工裁决返回 stop/reject 时停止或跳过          | Recipe 根据 human_decision 分支 |

不再做：

- 文件路径风险分析；
- 网络权限拦截；
- 工具调用拦截；
- 高危操作审批；
- 每个内部步骤的安全管控。

---

### 迁移参考 B：Runtime Framework 设计（旧版）

#### 旧 4.1 ContextBuilder

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

| 来源                | 用途                                              |
| ----------------- | ----------------------------------------------- |
| task              | 用户目标                                            |
| project_index     | 项目结构和约束                                         |
| selected Artifact | contract、planner_package、change_package、verdict |
| recent Event      | 进度、失败、预算状态                                      |
| previous outputs  | 上一轮结果                                           |
| handoff summary   | 上下文重置后的轻量交接                                     |
| workflow state    | loop 计数、分支状态、unit 状态                            |

ContextBuilder 可以把输入包写成 `context_package` Artifact，便于审计和复用。但这不是必须的；只有需要稳定引用或调试时才落盘。

#### 旧 4.2 ActivationRunner

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

#### 旧 4.3 Agent CLI / Adapter

Agent CLI 负责实际执行能力：

| 能力                    | 归属                              |
| --------------------- | ------------------------------- |
| 调模型                   | Agent CLI / adapter             |
| 工具调用                  | Agent CLI / adapter             |
| 结构化输出                 | Agent CLI / adapter             |
| schema repair         | Agent CLI / adapter             |
| 读写工作区                 | Agent CLI / adapter             |
| 最终输出 Artifact payload | Agent CLI / adapter 返回给 runtime |

Runtime 只定义边界：

```text
输入：ContextPackage + objective + expected_outputs + runtime_hints
输出：Artifact payload(s) + usage + status
```

#### 旧 4.4 RecipeRunner

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

#### 旧 4.5 BudgetTracker

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

#### 旧 4.6 HumanInterventionManager

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

</details>

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

| 入口          | 表达                             |
| ----------- | ------------------------------ |
| 启动前确认       | `Capability.approval.required` |
| Recipe 主动请求 | `requestHuman()` construct     |
| Policy 轻量暂停 | 预算、loop、approval 条件触发 waiting  |

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

| 概念       | 归属                       |
| -------- | ------------------------ |
| 人工介入能力   | Workflow/Runtime 层       |
| 启动前确认声明  | `Capability.approval` 字段 |
| 请求事实     | `Event`                  |
| 裁决内容     | `Artifact`               |
| 流程变化     | `Recipe` 分支              |
| 是否继续调度   | `Policy` 轻量检查            |
| 人类执行复杂任务 | 可选 `human.*` Agent       |

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

| 类型                | 表达                          |
| ----------------- | --------------------------- |
| fix-until-pass    | evaluator verdict 决定是否继续    |
| loop-until-dry    | findings 数量或连续空轮数决定是否继续     |
| polling loop      | external.wakeup Event 驱动下一轮 |
| review refinement | reviewer critique 决定是否再生成   |

循环限制：

```text
max_iterations
max_activations
max_total_tokens
max_recipe_depth
```

限制由 Policy 在调度下一步前检查。

---

# 

---

## 十三、一句话

新设计不是把 agent workflow 做成强安全微内核，而是把它做成：

```text
轻量原语 + Agent 承载 + Recipe 编排权 + ContextBuilder 输入构建 + Workflow Constructs 使用层 + 人工介入恢复点
```

Capability 只定义启动边界，Policy 只守住编排权和预算边界，Agent/CLI 承担实际工作，Workflow Constructs 提供 parallel、pipeline、branch、loop 和人工介入等高级能力。这样既能覆盖其它文档中的问题，也不会把原语层做重。
