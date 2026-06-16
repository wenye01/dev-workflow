# agentflow 六原语可用化设计方案

> 生成日期：2026-06-16
> 性质：设计方案。本文不讨论具体代码实现，只回答：六原语如果要变成真实可用的 workflow runtime，字段、子类型、校验和交互应该如何设计。
> 结论：仍然保持六原语，但每个原语都要有“可用化外壳”：类型族、字段契约、校验规则、失败路径和与其它原语的交互函数。

---

## 一、设计目标

六原语不是为了描述某一个固定流程，而是为了支撑多种真实任务：

- 只计划：只产出 plan / spec / contract / risk，不执行。
- 深度研究：搜索、阅读、抽取证据、综合报告、交叉验证。
- 依据计划执行：读取已有计划，按 unit/stage 执行。
- 代码开发：Planner / Generator / Evaluator / Fixer loop。
- 评审-only：对已有变更、文档、研究结果做独立审查。
- 迁移/批量变换：批量执行、隔离、验证、回滚。
- 自驱轮询：等待 CI、监控外部状态、定时唤醒。
- 人工协同：审批、选择方案、补充信息。

因此，原语设计必须满足：

1. **Agent 可以参与规划，但不能直接获得控制流。**
2. **所有跨边界状态必须 Artifact 化。**
3. **所有动态控制必须可 replay。**
4. **权限必须结构化，不靠 prompt。**
5. **默认路径轻，复杂路径由 Policy 按需触发。**
6. **用户写的是任务或计划，系统内部落的是受限 spec，不落任意脚本。**

---

## 二、总交互模型

真实可用的最小闭环：

```text
seed Artifacts / Events
  -> fold(EventLog, ArtifactStore) = SessionState
  -> decide(Recipe, state) = Directive
  -> expand(Recipe, Directive/plan Artifact) = Activation proposals
  -> gate(Policy, Activation, state) = Verdict
  -> schedule(admitted Activation, state)
  -> execute(Activation, Capability)
  -> write(Artifact)
  -> emit(Event)
  -> fold(...)
```

函数职责：

| 函数 | 设计职责 | 不允许做什么 |
| --- | --- | --- |
| `fold` | 从 Event + Artifact 建立可查询状态 | 不做业务判断 |
| `decide` | 判断下一步需要什么 Activation | 不调模型、不执行工具 |
| `expand` | 把 plan/spec 数据展开成 Activation proposals | 不信任 Agent 产出的任意控制流 |
| `gate` | 裁决放行、拒绝、审批、升级、停止 | 不决定业务下一步 |
| `schedule` | 处理依赖、锁、并发、lease、重试 | 不改变业务目标 |
| `execute` | 唯一不纯点，调用 agent/model/system/human | 不越过 Capability |
| `write` | 把结果转成稳定 Artifact | 不写无 schema 的跨边界状态 |
| `emit` | 记录 append-only 事实 | 不承载大体量内容 |

---

## 三、Activation：一次受控委派

### 3.1 Activation 应该怎么做

Activation 是系统能调度、授权、缓存、恢复和审计的最小运行边界。真实使用时，它不只是 “agent call”，还要覆盖系统命令、人类审批、计划展开、验证、聚合和压缩。

### 3.2 Activation 类型族

这些是 `Activation.kind` 或 `target.kind`，不是新增原语。

| 类型 | 用途 | 典型输出 | 默认能力 |
| --- | --- | --- | --- |
| `agent` | 多轮自主执行，可使用工具 | role_output、plan、change_package、critique | 按角色授予工具和 sandbox |
| `model` | 单次受限 LLM 操作：分类、打分、摘要、schema repair | classification、score、summary | 无工具或只读 Artifact |
| `system` | 命令、测试、schema 校验、转换、渲染、索引 | command_result、verification_report、canonical_artifact | 明确工具/文件范围 |
| `human` | 审批、选择、澄清、验收 | human_decision、approval | 无自动工具 |
| `aggregation` | 汇总多个输入、去重、投票、合并 verdict | aggregate_report、verdict | 通常只读 |
| `polling` | 查询外部状态，如 CI、issue、网页状态 | external_state、poll_result | 网络/connector 受限 |
| `memory` | 摘要、压缩、提取 handoff | summary、handoff、trace_digest | 只读相关 trace/artifacts |

说明：

- `aggregation`、`polling`、`memory` 可以由 agent/model/system target 承担；列出来是为了真实使用时有清晰的 activation role。
- Recipe 可以固定产生这些类型，也可以由 workflow_spec 数据驱动展开。

### 3.3 Activation 必需字段

```ts
interface ActivationSpec {
  id: string;
  run_id: string;

  kind: 'agent' | 'model' | 'system' | 'human' | 'aggregation' | 'polling' | 'memory';
  target: TargetRef;

  objective: ObjectiveSpec;
  input_artifacts: ArtifactInputRef[];
  expected_outputs: ExpectedOutputSpec[];
  capability_request?: CapabilityRequest;
  capability_grants: string[];

  parent?: string;
  dependency_hints?: DependencyHint[];
  lifecycle: LifecyclePolicy;
  cache: ActivationCachePolicy;
  resource_scope?: ResourceScope;

  metadata: {
    recipe_id: string;
    phase?: string;
    group?: string;
    priority?: number;
    risk?: 'low' | 'medium' | 'high';
    purpose?: 'plan' | 'research' | 'execute' | 'review' | 'verify' | 'aggregate' | 'approval';
  };
}
```

字段含义：

| 字段 | 含义 | 为什么需要 |
| --- | --- | --- |
| `kind` | 运行边界类型 | 让默认校验、默认 capability、UI 展示不同 |
| `target` | 谁来做，指向 target registry | Agent/Actor 不做原语，但需要可复用配置 |
| `objective` | 本次要完成什么 | 支撑 prompt、命令参数、人审问题 |
| `input_artifacts` | 显式输入 | 保证 context 可控、cache 正确 |
| `expected_outputs` | 输出契约 | 防止 Agent 返回不可消费内容 |
| `capability_request` | 这次希望要什么权限 | Agent/plan 可提出请求，但不能自动获得 |
| `capability_grants` | Policy 实际授予的能力 | 权限边界 |
| `parent` | 父 Activation | 支撑嵌套和动态展开 provenance |
| `dependency_hints` | 调度提示 | 支撑串行、barrier、pipeline |
| `lifecycle` | timeout/retry/cancel/failure policy | 长任务必须有界 |
| `cache` | 是否可复用以及 key 材料 | resume 和增量执行 |
| `resource_scope` | worktree/container/lock 分组 | 并发写安全 |
| `metadata` | recipe、phase、purpose、risk | UI、Policy、调度优先级 |

### 3.4 Activation 生成规则

真实可用时，Activation 不能让 Agent 随便生成可执行语法。

安全路径：

```text
Agent Activation
  -> writes workflow_spec Artifact
  -> schema validate
  -> semantic validate
  -> Recipe.expander converts spec to ActivationSpec
  -> Policy.gate every ActivationSpec
  -> Scheduler executes admitted Activations
```

禁止路径：

```text
Agent output arbitrary JS/Python/YAML
  -> runtime directly executes it
```

设计规则：

1. Agent 可以生成 `proposed_plan` / `workflow_spec` / `capability_request`，但不能直接写入 admitted Activation。
2. `expand` 只能使用受信任展开器，把受限数据转成 Activation。
3. `capability_request` 只能收窄或请求，实际 grant 由 Policy 决定。
4. 所有动态展开结果必须记录 `decision.recorded` Event。

---

## 四、Capability：结构化权限和资源边界

### 4.1 Capability 应该怎么做

Capability 不是“配置项集合”，而是执行边界的可检查授权。它让同一个 Agent 在不同 Activation 中拥有不同能力。

### 4.2 Capability 类型族

| 类型 | 作用 |
| --- | --- |
| `artifact_scope` | 允许读写哪些 Artifact kind/ref/schema |
| `file_scope` | 允许读写哪些路径，是否允许破坏性操作 |
| `tool_scope` | bash、git、browser、MCP、Playwright、search、database |
| `network_scope` | 是否允许网络、允许哪些域名/方法 |
| `sandbox_scope` | none/worktree/container，是否保留环境 |
| `credential_scope` | 凭据别名、用途、注入方式 |
| `budget_scope` | token、call、wall time、external cost |
| `approval_scope` | 哪些动作需要 human approval |
| `observability_scope` | trace 粒度、stdout 捕获、内部工具摘要 |

### 4.3 Capability 必需字段

```ts
interface CapabilityGrant {
  id: string;
  run_id: string;
  activation_id?: string;

  artifact_scope: {
    read: ScopeRule[];
    write: ScopeRule[];
  };
  file_scope: {
    read: string[];
    write: string[];
    destructive_ops: 'deny' | 'approval' | 'allow';
  };
  tools: ToolGrant[];
  network: {
    mode: 'deny' | 'allowlist' | 'allow';
    allowlist?: string[];
  };
  sandbox: {
    mode: 'none' | 'worktree' | 'container';
    retention: 'discard' | 'keep_on_failure' | 'keep';
  };
  credentials: CredentialGrant[];
  budget: {
    max_tokens?: number;
    max_calls?: number;
    max_wall_time_ms?: number;
    max_external_cost_usd?: number;
  };
  approval_required?: ApprovalRequirement[];
  observability: {
    event_level: 'minimal' | 'lifecycle' | 'tool_summary' | 'full_trace';
    capture_stdout: 'none' | 'summary' | 'full';
    capture_intermediate_artifacts: boolean;
  };
}
```

### 4.4 Capability 设计规则

1. **默认拒绝**：未授予的工具、路径、网络、凭据都不可用。
2. **单次授权**：Capability 绑定到 Activation 或 Activation group，不是 Agent 永久能力。
3. **计划只请求，Policy 才授予**：Agent 产出的 plan 不能直接扩大权限。
4. **凭据不进入 Agent 文本上下文**：只通过 tool proxy / credential alias 使用。
5. **观测粒度可调**：失败、高风险、调试时提高 trace；默认轻量。

---

## 五、Artifact：多场景稳定状态

### 5.1 Artifact 应该怎么做

Artifact 是所有场景的共同语言。它必须同时支持计划、研究、代码变更、验证、人审、外部状态、记忆压缩和最终报告。

### 5.2 Artifact 的三层形态

每个 Agent/系统输出建议分三层：

| 层 | 作用 | 是否给后续 Recipe 使用 |
| --- | --- | --- |
| `raw` | 原始输出，保留调试和审计 | 通常不直接使用 |
| `canonical` | schema 校验后的标准 payload | 是 |
| `view` | markdown、diff、summary、HTML 等人类视图 | 可选 |

这样可以解决 “Agent 输出格式偶尔有问题”：

```text
Agent writes raw Artifact
  -> normalizer / schema validator
  -> canonical Artifact
  -> semantic validators
  -> Recipe/Policy only consume canonical Artifact
```

### 5.3 Artifact 类型族

| 场景 | Artifact kind |
| --- | --- |
| 输入/上下文 | `task`、`project_index`、`context`、`external_state` |
| 计划 | `plan`、`workflow_spec`、`unit_spec`、`batch_schedule`、`contract`、`risk_report` |
| 研究 | `source_index`、`source_snapshot`、`note`、`evidence`、`claim`、`synthesis`、`research_report` |
| 执行 | `role_output`、`change_package`、`patch`、`command_result`、`verification_report` |
| 评审 | `critique`、`finding`、`verdict`、`judgement`、`qa_report` |
| 控制 | `decision`、`human_decision`、`approval`、`rejection` |
| 记忆 | `handoff`、`summary`、`trace_digest`、`open_questions` |
| 输出 | `final_report`、`delivery_package` |

### 5.4 Artifact 必需字段

```ts
interface ArtifactRecord<T = unknown> {
  id: string;
  run_id: string;
  ref: string;
  kind: ArtifactKind;
  schema_id: string;
  schema_version: string;
  content_hash: string;

  producer: {
    activation_id?: string;
    target_ref?: string;
    external?: string;
  };
  input_refs: string[];

  payload?: T;
  storage_uri?: string;
  raw_ref?: string;
  canonical_ref?: string;

  validations: ValidationResult[];
  views?: {
    markdown?: string;
    summary?: string;
    diff?: string;
    report?: string;
  };
  lineage: {
    supersedes?: string;
    derived_from?: string[];
  };
  retention: 'ephemeral' | 'run' | 'long_term';
}
```

### 5.5 如何保证 Agent 生成不出语法错误

设计上不能假设 Agent 永远输出合法 JSON。要把“生成错误”变成可恢复状态。

方案：

1. **输出契约先行**  
   Activation 的 `expected_outputs` 明确 schema、ref、必需性和语义检查。

2. **raw 永远可写**  
   Agent 原始输出先写 `raw` Artifact，不因为格式错误丢失。

3. **canonical 必须校验**  
   后续 Recipe/Policy 只读 canonical Artifact。raw 不能直接驱动控制流。

4. **结构化输出优先，但不信任**  
   即使使用 JSON schema / structured output，也仍然经过 schema validator。

5. **语法修复是 Activation，不是隐式魔法**  
   schema 不合法时可以触发 `model.schema_repair` 或 `system.normalizer` Activation，产出新的 canonical Artifact。

6. **语义校验分层**  
   JSON 形状合法不代表可用。比如 planner package 还要校验 unit/batch/contract 引用一致。

7. **失败可见**  
   修复失败写 `artifact.validation_failed` / `activation.failed` Event，由 Policy 决定重试、降级、升级或停止。

8. **控制面只接受受限 schema**  
   workflow spec 只能包含 enum、refs、limits、stage、input/output schema，不能包含任意代码。

---

## 六、Event：事实流和恢复边界

### 6.1 Event 应该怎么做

Event 记录“发生过什么”，不是保存全部内容。它必须足以恢复、审计、调试、重放动态决策和连接外部世界。

### 6.2 Event 类型族

| 事件族 | 示例 |
| --- | --- |
| Run | `run.started`、`run.completed`、`run.stopped` |
| Recipe | `recipe.selected`、`decision.recorded`、`directive.proposed` |
| Activation | `activation.requested`、`started`、`completed`、`failed`、`cancelled` |
| Capability | `capability.requested`、`granted`、`denied`、`revoked` |
| Artifact | `artifact.raw_written`、`artifact.written`、`validated`、`validation_failed` |
| Policy | `policy.admitted`、`rejected`、`approval_requested`、`escalated`、`stopped` |
| Scheduler | `scheduler.queued`、`deferred`、`ready`、`lease_acquired`、`lease_released` |
| Budget | `budget.charged`、`budget.exhausted` |
| External | `external.wakeup_fired`、`ci.updated`、`webhook.received` |
| Human | `human.requested`、`human.approved`、`human.rejected`、`human.answered` |
| Progress | `phase.started`、`progress.logged` |

### 6.3 Event 必需字段

```ts
interface EventRecord {
  seq: number;
  run_id: string;
  type: string;

  activation_ref?: string;
  artifact_ref?: string;
  capability_ref?: string;

  causation_id?: string;
  correlation_id?: string;
  state_hash?: string;

  payload: Record<string, unknown>;
  recorded_at: string;
}
```

### 6.4 Event 设计规则

1. Event append-only，不修改历史。
2. 大内容进 Artifact，Event 只放摘要和引用。
3. 动态决策必须写 `decision.recorded`，resume 时优先 replay。
4. 外部输入必须先变 Event，Recipe 不能隐式读时钟或外部状态。
5. Event 的 `causation_id` 连接决策、审批、升级和执行结果。

---

## 七、Recipe：可重放编排策略

### 7.1 Recipe 应该怎么做

Recipe 是“下一步做什么”的策略。真实可用时，它要支持固定流程、只计划、研究、依据计划执行、动态 spec 展开和质量模式组合。

### 7.2 Recipe 类型族

| 类型 | 说明 |
| --- | --- |
| `deterministic` | 受信任代码/配置，直接根据 state 产 Directive |
| `spec_driven` | 读取 `workflow_spec` Artifact，由 expander 展开 |
| `recorded_dynamic` | human/LLM 参与决策，但 decision 先记录再执行 |
| `pattern_composed` | 由内置 pattern 组合：research、review panel、loop-until-dry |
| `selector` | 根据 task/risk 选择另一个 Recipe |

### 7.3 Recipe 必需字段

```ts
interface RecipeSpec {
  id: string;
  name: string;
  version: string;
  mode: 'deterministic' | 'spec_driven' | 'recorded_dynamic' | 'pattern_composed' | 'selector';

  input_contract: string[];
  state_selectors: StateSelector[];
  decide_ref: string;
  expander_ref?: string;

  output_contract: {
    done_artifact_kinds: string[];
    stop_artifact_kinds?: string[];
  };

  limits: {
    max_activations?: number;
    max_depth?: number;
    max_iterations?: number;
    max_parallelism?: number;
  };

  replay_policy: {
    dynamic_decisions: 'replay_recorded' | 'recompute_if_inputs_changed';
  };
}
```

### 7.4 Directive 设计

```ts
type Directive =
  | { kind: 'propose'; activations: ActivationSpec[] }
  | { kind: 'wait'; reason: string; waiting_for: string[] }
  | { kind: 'done'; result_artifact?: string; summary?: string }
  | { kind: 'stop'; reason: string; details?: Record<string, unknown> };
```

`wait` 很重要：真实任务常常在等人审、CI、外部唤醒、依赖 Artifact。等待不是失败。

### 7.5 Recipe 设计规则

1. Recipe 只读 `SessionState`。
2. Recipe 不直接调模型。需要模型判断时，propose Model/Agent Activation。
3. Recipe 不直接使用 raw Artifact 驱动控制流。
4. Recipe 可以组合 pattern，但 pattern 只是 Activation 拓扑模板。
5. 动态 workflow spec 必须受 schema、limits、Policy 三重约束。

---

## 八、Policy：裁决、升级和停止

### 8.1 Policy 应该怎么做

Policy 回答“该不该做、要不要升级、是否需要人审、何时停止”。它让默认路径保持轻量，同时允许高风险任务自动加重。

### 8.2 Policy gate 类型

| Gate | 作用 |
| --- | --- |
| `capability_gate` | 检查 capability request 是否越权 |
| `schema_gate` | 检查输入/输出 schema 是否允许 |
| `budget_gate` | 检查全局和局部预算 |
| `risk_gate` | 高风险路径、破坏性操作、凭据、网络 |
| `approval_gate` | 需要人审时生成 Human Activation |
| `quality_gate` | 置信度、证据、测试结果、评分阈值 |
| `escalation_gate` | 多轮失败、分歧、低置信时追加复杂路径 |
| `stop_gate` | 递归深度、循环、预算耗尽、不可恢复错误 |

### 8.3 Policy Verdict

```ts
type PolicyVerdict =
  | { kind: 'admit'; capability_grants: string[] }
  | { kind: 'reject'; reason: string; repair_hint?: string }
  | { kind: 'request_approval'; human_activation: ActivationSpec }
  | { kind: 'escalate'; activations: ActivationSpec[]; reason: string }
  | { kind: 'stop'; reason: string };
```

### 8.4 Policy 设计规则

1. `admit` 必须给出实际 capability grants。
2. `reject` 不等于停止，可以让 Recipe 修复 plan 或重新生成。
3. `request_approval` 本质是 Human Activation。
4. `escalate` 本质是插入 reviewer、verifier、adversary、summarizer、repairer Activation。
5. `stop` 必须写明可审计 reason。
6. Policy 不产生业务目标，只裁决 Activation proposal。

---

## 九、Agent 生成内容的安全设计

真实使用里，Agent 会生成计划、研究结论、代码修改说明、workflow spec、capability request。设计上要允许它生成，但不能让它破坏控制面。

### 9.1 Agent 可以生成什么

| 可生成内容 | 落点 |
| --- | --- |
| plan / workflow spec | Artifact，schema constrained |
| unit list / dependency graph | Artifact payload |
| contract / acceptance criteria | Artifact |
| claim / evidence / report | Artifact |
| capability request | Artifact 或 Activation 字段的 request 部分 |
| proposed fix / patch summary | Artifact |
| questions for human | Artifact 或 Human Activation proposal data |

### 9.2 Agent 不可以直接生成什么

| 禁止内容 | 替代设计 |
| --- | --- |
| 任意可执行脚本作为控制流 | 生成受限 `workflow_spec` |
| admitted Activation | 只能生成 proposed plan，Recipe.expander 转换 |
| 直接扩大权限 | 只能生成 capability_request，Policy 裁决 |
| raw JSON 直接驱动 Recipe | 先 canonicalize + validate |
| 直接写全局状态 | 只能写 Artifact/Event |

### 9.3 可用的 workflow_spec 形态

workflow spec 应是数据，不是代码：

```json
{
  "kind": "workflow_spec",
  "recipe": "execute-plan",
  "units": [
    {
      "id": "unit-auth-refresh",
      "goal": "Implement auth refresh behavior",
      "inputs": ["task", "project_index"],
      "outputs": [
        { "kind": "change_package", "schema": "agentflow.change_package.v1" }
      ],
      "depends_on": [],
      "allowed_paths": ["src/auth/**", "tests/auth/**"],
      "verification": [
        { "kind": "command", "command_ref": "npm-test-auth" }
      ]
    }
  ],
  "limits": {
    "max_parallelism": 4,
    "max_fix_rounds": 2
  }
}
```

关键点：

- `command_ref` 指向受信任 command registry，不直接写 shell 字符串。
- `allowed_paths` 只能作为 capability request，Policy 可以收窄或拒绝。
- `recipe` 指向已知 recipe，不允许动态 import。
- 所有 outputs 都有 schema。

---

## 十、典型场景如何落地

### 10.1 只计划

```text
task Artifact
  -> planner Activation
  -> workflow_spec / contract / risk_report Artifacts
  -> Policy validates scope
  -> Recipe Done
```

需要的设计点：

- Planner 只读上下文，不写文件。
- 输出 schema 必须能表达 units、dependencies、contracts、risks、capability requests。
- 计划越权不是执行失败，而是 Policy reject 或 planner-repair。

### 10.2 深度研究

```text
question Artifact
  -> search Activation(s)
  -> source_index Artifacts
  -> extract Activation(s)
  -> evidence / notes Artifacts
  -> synthesize Activation
  -> claims / report Artifact
  -> verifier/adversary if weak evidence
```

需要的设计点：

- evidence 必须有 source refs。
- claim 必须引用 evidence。
- conflicting sources 进入 Policy escalation。
- 网络和外部 API 通过 Capability 控制。

### 10.3 依据计划执行

```text
workflow_spec Artifact
  -> Recipe.expander
  -> unit Activations
  -> verifier Activations
  -> aggregate report
```

需要的设计点：

- plan 作为 seed Artifact 即可，不需要重新 Planner。
- expander 只接受 canonical workflow_spec。
- unit 并发由 dependency + file write scope 控制。

### 10.4 评审-only

```text
change_package/report Artifact
  -> reviewer Activations
  -> critique/finding Artifacts
  -> aggregation Activation
  -> verdict Artifact
```

需要的设计点：

- reviewer 独立读取同一输入，不共享中间上下文。
- finding schema 必须有 evidence、severity、confidence。
- 分歧触发 judge/adversary。

### 10.5 自驱轮询

```text
external.wakeup_fired Event
  -> polling Activation
  -> external_state Artifact
  -> Policy decides next wait/stop/escalate
```

需要的设计点：

- 时间是 Event，不是 Recipe 隐式输入。
- 下一次 delay 是 Artifact/Event payload。
- 最大生命周期和轮数由 Policy stop_gate 控制。

---

## 十一、最小可用规范集

要让六原语实际可用，至少需要定义这些 schema/契约：

| 规范 | 用途 |
| --- | --- |
| `ActivationSpec` | 所有运行边界的统一表示 |
| `CapabilityGrant` | 权限和资源授权 |
| `ArtifactRecord` | 跨边界状态存储 |
| `EventRecord` | append-only 事实 |
| `RecipeSpec` | 编排策略元数据 |
| `PolicySpec` | 裁决规则元数据 |
| `WorkflowSpec` | Agent 可生成的受限计划数据 |
| `ValidationResult` | schema/semantic 校验结果 |
| `PolicyVerdict` | gate 输出 |
| `Directive` | decide 输出 |

这些是设计契约，不要求一次性实现完整 runtime。

---

## 十二、一句话

可用化后的六原语不是“六个名词”，而是一套受限控制面：

> Agent 只能生成受限 Artifact；Recipe 只读 canonical state 并提出 Activation；Policy 裁决权限、风险和升级；Capability 兑现执行边界；Activation 在边界内运行；Artifact 和 Event 外化全部可恢复状态。这样只计划、深度研究、依据计划执行、代码开发、评审、迁移、轮询、人审都能落到同一个设计上，而且不会因为 Agent 输出语法错误或越权计划破坏系统。

