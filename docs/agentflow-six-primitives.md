# agentflow 六原语：多 Agent 协作的最小基底

> 生成日期：2026-06-15
> 性质：**原语规范（正典）**。本文固化多 Agent 协作框架的六个最小职责单位、它们的内部结构、彼此的交互机制。所有上层能力（并发、流水线、人工编排、嵌套、对抗性审查）均为这六个原语的组合，不新增原语。
> 关联文档：
> - [agentflow-kernel-design.md](./agentflow-kernel-design.md) — 机制层（Step / 事件溯源 reducer / Decision 纯性）
> - [agentflow-primitive-basis.md](./agentflow-primitive-basis.md) — 语义层（Activation 中心，七原语雏形）
> - [agentflow-multi-agent-framework-thoughts.md](./agentflow-multi-agent-framework-thoughts.md) — 治理层（Actor / Policy / 复杂度控制）
> - [agentflow-six-primitives.html](./agentflow-six-primitives.html) — 可交互演示
>
> 本文是上述三份"原语"文档的**收敛版本**。术语对照见 [第六节](#六降级为什么不是原语)。

---

## 一、原语判据

> **原语 = 多 Agent 协作下难以继续拆分的职责单位。**

判定标准：

- **往下拆反而增加系统复杂度的，保留为原语。**
- 能由其它原语合成的，是**视图**或**推论**，不列为原语。
- 不运行、不产出、只作为参数存在的，**降级**为字段。
- 被抽象出来后，背后实现是可以随意替换的，如

据此，本框架的稳定基底收敛为 **6 个原语**。前序文档中的 `Session`、`Actor`、`Scheduler`、`Budget` 经判据检验后均**降级**（见第六节）。

---

## 二、六原语总览

```text
执行轴   Activation     一次受控委派：把目标交给谁、在什么约束下、期望什么产物
约束轴   Capability     静态能力边界：这次被允许用什么工具、资源、预算
状态轴   Artifact       跨边界稳定产物：唯一能被后续引用的状态
事实轴   Event          append-only 事实流：恢复、审计、重放的唯一来源
编排轴   Recipe         读状态 → 提议下一步（纯函数）
裁决轴   Policy         准许 / 升级 / 停止（动态裁决）
```

核心循环（详见 [第四节](#四原语交互)）：

```text
        ┌─────────────────────────────────────────────────────┐
        │                                                     ▼
   Session = fold(EventLog, ArtifactStore)            (视图，非原语)
        │
        ▼
   decide(Recipe, Session) ───► Directive: propose [Activation] | Done | Stop
        │                     （纯函数，只读 fold，永不直接调模型）
        ▼
   gate(Policy, Activation, signals) ───► admit | escalate | stop
        │                     （裁决，同样只读 fold）
        ▼
   Scheduler.admit ──► Activation 在 Capability 边界内执行
        │
        ▼
   emit Events · write Artifacts ──► Session 更新 ──► 重新 fold
```

---

## 三、原语内部

### 3.1 Activation（执行轴）

**职责**：一次受控委派——在当前 Session 中，把什么目标交给谁、在什么约束下运行、期望它产出什么。

**为什么拆不下去**：它是多 Agent 协作的原子动作。拆成 objective / 输入 / 输出 / 约束，就丧失了"一次委派"的整体语义，无法描述协作范式。

**内部内容**：

| 字段 | 含义 |
| --- | --- |
| `id` | 唯一标识 |
| `target` | 指向执行主体（原 `Actor` 降级进此字段） |
| `objective` | 目标 |
| `input_artifacts` | 输入引用（其 hash 参与缓存 key） |
| `expected_outputs` | 输出契约（schema + 期望产出） |
| `capability_grants` | 指向本次授予的 [Capability](#32-capability约束轴) |
| `parent` | 父 Activation（构成层次树，见 [案例 C](#案例-c嵌套编排)） |
| `dependency_hints` | 依赖提示（与 input_artifacts 配合驱动调度） |
| `resource_scope` | 资源范围（worktree / container lease 归属） |
| `lifecycle` | timeout / cancel / retry 上限 |
| `budget_class` | 预算扣费类别 |
| `metadata` | recipe / phase / group / priority |

**不承担**：不管理 Agent 内部每一条 bash / 工具调用（那是 Agent-internal trace，归 executor 层，见 [案例 C](#案例-c嵌套编排)）。

**关键性质**：同一 `target` 可被多次 Activation 启动，每次目标、权限、输出不同。

---

### 3.2 Capability（约束轴）

**职责**：一次 Activation 被授予的能力、资源与权限。把"允许做什么"从自然语言中剥离成内核可检查的边界。

**为什么拆不下去**：没有它就描述不了"受限委派"——多 Agent 协作的核心就是多个自主执行者在受限边界下工作。prompt 不是安全边界。

**内部内容**：

| 字段 | 含义 |
| --- | --- |
| `file_read_scope` / `file_write_scope` | 可读写路径（驱动 Scheduler 写锁判定） |
| `tools` | bash / git / mcp / browser 等 |
| `network` | 是否允许网络 |
| `sandbox` | `none` / `worktree` / `container` |
| `budget` | **本次** Activation 的 token / wall_time / call 上限 |
| `credentials` | 凭据范围 |
| `external_quota` | 外部 API 配额 |
| `approval_required` | 是否需人工 |

**不承担**：不决定业务目标（那是 Recipe）；不动态升级（那是 Policy）。

**与 Budget 的关系**：Budget 分两层——**单 Activation 预算**归这里；**全局预算**归 [Policy](#36-policy裁决轴)。避免单一概念承载两层语义。

---

### 3.3 Artifact（状态轴）

**职责**：唯一稳定跨边界的状态。任何要影响其它 Activation、Recipe 或恢复流程的内容，都必须被外化成 Artifact。

**为什么拆不下去**：与 Event 正交（状态快照 vs 事实流），不可互替，也不可由其它原语合成。

**内部内容**：

| 字段 | 含义 |
| --- | --- |
| `ref` | 稳定逻辑路径 |
| `schema_id` | 结构契约（runtime 校验） |
| `content_hash` | 内容寻址（参与 Activation 缓存 key） |
| `producer` | 由哪个 Activation 产出 |
| `input_refs` | 依赖了哪些输入 |
| `payload` | 结构化内容（typed） |
| `views` | 可选：markdown / summary / human-readable 渲染 |

**不承担**：不承载隐式上下文；不保存过程（过程归 Event）。

**关键性质**：`ref` 不变、`content_hash` 变 = 引用更新（修订版）。同 `ref` 多版本由 hash 区分。

---

### 3.4 Event（事实轴）

**职责**：append-only 的事实记录。Session 的真相来源不是模型上下文，而是 EventLog + ArtifactStore。

**为什么拆不下去**：恢复、审计、重放、成本核算、失败定位的唯一来源。

**内部内容**：

| 字段 | 含义 |
| --- | --- |
| `type` | 事件类型（见下） |
| `seq` | 顺序号（fold 的依据） |
| `activation_ref` | 归属 Activation |
| `payload` | 事实细节 |

**典型事件**：

```text
session.started          activation.requested     capability.granted
recipe.selected          activation.started       capability.revoked
decision.recorded        activation.completed     budget.charged
activation.failed        artifact.written         human.approved
session.stopped
```

**不承担**：不作为可变状态表；不是"全量思维记录"，是事实记录。

---

### 3.5 Recipe（编排轴）

**职责**：组织多 Agent 协作的控制策略。读取 `fold` 出的 SessionState，提议下一步 Activation，直到 Done 或 Stop。

**为什么拆不下去**：与执行（Activation）、裁决（Policy）构成正交三轴，并回任一个都会职责膨胀。

**内部结构（两半，必须分清）**：

| 部分 | 职责 | 由谁承担 |
| --- | --- | --- |
| **决策** | 读 state、产出"下一步要做什么" | 受信任代码 **或** 一个被 Activation 调度的 Agent |
| **展开** | 把决策转成真正的 Activation 提议 | Recipe 代码（内核展开器） |

> 这条两半的划分是嵌套编排成立的关键，详见 [案例 C](#案例-c嵌套编排)。

**契约**：

```text
Recipe: (state) → Directive
Directive ∈ {
  propose: [Activation],
  done:    result,
  stop:    reason
}
```

**三形态**：

```text
Deterministic Recipe     受信任代码，确定性产生 activations（人工编排的正典形态）
Recorded Dynamic Recipe  可含 LLM / human / 动态控制，但每次 decision 必须记录为 Event
Agentic Proposal         Agent 提出下一步动作，但必须过 Policy/Capability/Scheduler gate
```

**不承担**：不直接调模型做控制流（LLM 决策先固化为 Event/Artifact 再被读取）；不裁决（那是 Policy）。

---

### 3.6 Policy（裁决轴）

**职责**：动态裁决。根据风险、失败、分歧、预算信号，决定 Activation 放行、升级复杂度还是停止。

**为什么拆不下去**：并回 Recipe 会把"做什么"与"该不该做"耦合，反而更复杂。静态权限归 Capability，全局预算与动态升级归这里。

**内部内容**：

| 字段 | 含义 |
| --- | --- |
| `capability_gate` | 权限检查（与 Capability 对齐） |
| `budget_gate` | **全局**预算检查 |
| `risk_gate` | 风险检查（高危文件 / 破坏性操作） |
| `escalation_rules` | 低置信 / 多轮失败 / 分歧 → 升级触发条件 |
| `stop_conditions` | 终止条件（含递归深度 / 循环检测） |
| `human_approval_gate` | 人工审批门 |

**核心职责**：复杂能力应由 Policy 按需触发，而非内核默认路径。默认路径接近单 Agent 成本；复杂性只在风险、失败、分歧、上下文压力出现时展开。

**不承担**：不提议做什么（那是 Recipe）。

---

## 四、原语交互

### 4.1 五个交互函数

整套范式只需要这五个函数。前三个由 Activation 触发，后两个是内核循环的每一拍。

| # | 函数签名 | 语义 |
| --- | --- | --- |
| 1 | `activate(target, objective, capability) → Activation` | 委派：把目标交给某执行主体，附上能力边界 |
| 2 | `write(activation, artifact) → Artifact` | 产出：外化为可被后续引用的稳定状态 |
| 3 | `emit(activation, event) → Event` | 留痕：append-only 追加事实 |
| 4 | `decide(recipe, fold(events, artifacts)) → Directive` | 编排：纯函数读状态，提议下一步 |
| 5 | `gate(policy, activation, signals) → admit \| escalate \| stop` | 裁决：是否放行 / 升级 / 终止 |

### 4.2 内核循环

```text
state = fold(event_log, artifact_store)              # 视图，每次重新折叠
loop:
  directive = decide(Recipe, state)                  # 纯：决定下一步，永不直接调模型
  if directive is Done/Stop: break
  for activation in directive.propose:
     verdict = gate(Policy, activation, signals)     # 纯：裁决
     match verdict:
       admit     → Scheduler.admit(activation)       # 依赖就绪 / 资源锁 / 并发上限
                    run activation within Capability # 唯一不纯点：执行
                    activation emits Events, writes Artifacts
       escalate  → 注入升级路径（如追加 reviewer panel Activation）
       stop      → break
  state = fold(event_log, artifact_store)            # 重新折叠，继续
```

### 4.3 关键不变量

1. **Activation 是运行时边界。** 内核管理一次受控委派，不管 Agent 内部每个动作。
2. **`decide` / `gate` 只读 `fold`，永不直接调模型。** 故即使整个 workflow 是 AI 驱动的，编排与裁决层依然 100% 可重放。LLM 的任何决策必须先固化成 Event/Artifact，再被这两个纯函数读取。
3. **Agent 产数据，不产控制流。** Agent 可提议、可产计划 Artifact，但真正的 Activation 提议由 Recipe 展开。
4. **Capability 是权限边界。** prompt 不是安全边界；能力授予必须结构化。
5. **Artifact 是唯一跨边界状态。** 不外化的内容不构成系统状态。
6. **Event 是事实来源。** append-only，重要生命周期、决策、权限、产物皆入 log。
7. **动态决策必须可审计。** 动态控制可存在，但 decision 必须记录为 Event，恢复时可 replay。
8. **默认路径必须轻。** 全量 trace、额外压缩、judge panel、adversarial review 应按风险与预算触发，而非内核默认。

---

## 五、原语关系图

```text
Recipe      reads fold(state)        proposes Activations
  │
  ▼
Policy      gates Activations        escalates / stops
  │
  ▼
Scheduler   admits (依赖 / 锁 / 并发 / 预算)   ← 内核模块，非原语
  │
  ▼
Activation  targets 执行主体          holds Capability grants
  │           │
  │           ├─► emit  ──► Event    ──► EventLog ─┐
  │           └─► write ──► Artifact ──► ArtifactStore ─┤
  │                                                     ▼
  └──────────────────────────────────────────► fold = SessionState
```

---

## 六、降级：为什么不是原语

经 [原语判据](#一原语判据) 检验后，以下概念**不列为原语**，由六原语合成或承载：

| 概念 | 它到底是什么 | 推导 |
| --- | --- | --- |
| **Session** | `fold(EventLog, ArtifactStore)` 的视图 | 没有独立职责，是 Event + Artifact 的命名空间 |
| **Actor** | `Activation.target` 的可复用配置 | 不运行、不产出，只是参数；含 role/executor/context-strategy/tool-policy/output-contract |
| **Scheduler** | 内核模块 | 解释依赖、资源锁、并发、生命周期；是实现机制不是职责原语 |
| **Budget** | 分两层 | 单 Activation 预算 → Capability；全局预算 → Policy |
| **parallel** | Recipe 一次提议多个 Activation + Scheduler 并发 | 见 [案例 A](#案例-a并行与流水线) |
| **pipeline** | 按 Artifact 依赖就绪逐个启动 | 见 [案例 A](#案例-a并行与流水线) |
| **barrier / join** | 一个多输入依赖的 Aggregation Activation | 其 input_artifacts 引用所有并行输出 |
| **handoff** | `Artifact + Event + next Activation input` | 三原语组合 |
| **phase** | Event metadata / Activation group | 非原语 |
| **cache / resume** | Activation input/capability/executor-version/artifact-hash 的稳定 key + 日志重放 | 白拿，非功能 |
| **嵌套编排** | Activation 的 `parent/child` 树 | Recipe 组合（非递归）；见 [案例 C](#案例-c嵌套编排) |

> **与前序文档的术语对照**：
> - 本文 `Activation` ≡ kernel-design 的 `Step`（当 target 为系统能力时）≡ primitive-basis 的 `Activation`
> - 本文砍掉了 primitive-basis 的 `Session`、`Agent`（→ 降为 `target`），砍掉了 thoughts 的 `Actor`、`Session`、`Scheduler`
> - 本文把 thoughts 中散落在 Capability/Policy/Budget 三处的"约束"正交切清：静态权限→Capability，全局预算+动态升级→Policy

---

## 七、使用案例

以下案例演示六原语如何组合出上层能力。**所有案例都不新增原语。**

### 案例 A：并行与流水线

**问题**：能否支持 Claude Code dynamic workflow 的 `parallel`（barrier 并发）与 `pipeline`（无 barrier 流水线）？

**原语表达**：

| 模式 | 表达 |
| --- | --- |
| **parallel** | Recipe 一次 `propose [A1, A2, ..., AN]`；Scheduler 在它们的 `write_scope` / `sandbox` 不冲突时并发执行，受并发上限约束 |
| **barrier / join** | 额外提议一个 Aggregation Activation，其 `input_artifacts` 引用 A1..AN 的输出；依赖未满足前 Scheduler 不启动它 |
| **pipeline（无 barrier）** | Recipe 对每个 item 独立持续提议下一步；每个 stage 的 `input_artifacts` 引用上一 stage 的 Artifact；Scheduler 按依赖就绪逐个启动，item 间互不等待 |
| **并发安全** | 每个 Activation 的 Capability 声明 `write_scope` + `sandbox=worktree`；Scheduler 分配 worktree lease + 文件写锁 |

```text
parallel(8 units):                    pipeline(items, analyze, verify):
  propose [u1..u8]                      for each item: propose analyze(item)
  Scheduler 并发 (≤ min(16,cpu-2))       analyze.out → propose verify(analyze.out)
  各自 worktree, write_scope 隔离         item A 在 verify 时 B 仍在 analyze
  propose aggregator(input=[u1..u8])     无 barrier
```

**关键点**：parallel / pipeline 在 Recipe 层就能写出来；并发与串行是 **Scheduler 的实现维度**，不在原语层。若当前 Scheduler 是串行 admit，那是实现选择，不是原语限制。

---

### 案例 B：人工编排（确定性 Recipe）

**问题**：能否由人工编排出流程，而非必须 LLM 自主规划？例如三模块 planner / generator / evaluator，planner 下 3 个 Agent 讨论、generator 下 8 个并行、evaluator 4 个串行审核，不通过回 generator，每个 Agent 的上下文 / 定义 / 后端可不同或相同。

**这是 `Deterministic Recipe` 的标准用例——最受信任、最可重放、最可单测的形态。** Recipe 是纯代码，不调 LLM 做控制流。

```text
phase planner:                                   ← phase = Activation group
  并行 propose 3 个 Activation:
    A1 target=planner.strategist   input=task+index
    A2 target=planner.decomposer   input=task+index      ← 每个 target/input/capability 独立
    A3 target=planner.critic       input=task+index
  → 各 write planner_proposal
  → propose aggregator(input=[A1,A2,A3].out) → write planner_package

phase generator:
  对 planner_package.units 每个 unit:
    并行 propose 8 个 Activation:
      target 全部 = generator.implementer (同后端)        ← "相同"= 指向同一 target
      capability.sandbox=worktree, write_scope=该 unit   ← 各自隔离
      input_artifacts 各自不同 (各自 unit)                ← 上下文不同

phase evaluator:
  串行 propose 4 个 Activation (依赖链):
    R1 target=reviewer.security     input = change_package
    R2 target=reviewer.perf         input = change_package + R1.report   ← 后一个含前一个 Artifact
    R3 target=reviewer.correctness  input = ... + R2.report
    R4 target=reviewer.style        input = ... + R3.report → write verdict

loop:
  decide(Recipe, state):
    if verdict != pass: propose 新 generator fix Activation   ← 循环 = 读 state 的结果
    else:               Done
```

**关键点**：
- 每个 Agent 上下文 / 定义 / 后端"不同或相同" = Activation 的 `target` / `input_artifacts` / `capability_grants` 三字段独立绑定。"相同"= 多 Activation 指向同一 target；"不同"= 指向不同 target。
- 原语框架的**正典形态恰恰是人工/代码编排**。LLM 自主规划只是 Recipe 的 Agentic 形态，且必须受 Policy gate 约束。
- 当前系统"全程 LLM 自主规划"是一种 Recipe 选择，不是框架上限。

---

### 案例 C：嵌套编排

**问题**：一个 Activation 能否作为编排者，再编排其它 Agent 完成自己的任务？

#### 概念矫正（三个必须分清的"嵌套"）

| | 是什么 | 内核可见 | 享受内核能力 |
| --- | --- | --- | --- |
| **① Recipe 代码组合** | 外层 Recipe 调用内层 Recipe 函数，合并 Directive | 内核只认一个扁平 Recipe | — |
| **② Activation 层次** | 子 Activation 带 `parent`，形成树 | ✅ 全可见 | ✅ 全享受 |
| **③ Agent 内部 spawn** | Agent 在自己的 executor 里直接调子 Agent | ❌ Agent-internal trace | ❌ 不享受 |

> **Recipe 不嵌套**——它是纯函数，只能组合。真正的运行时层次在 **② Activation 的 `parent/child`**（原语本就有的字段）。
> **③ 黑盒 spawn 不归原语/内核管**——它属于 executor 层。原语只管 Activation 边界。
> **"Activation 作为编排者"是角色错位**——Activation 永远是被编排对象，编排者只有 Recipe。

#### 正确表达：数据驱动的分层展开

```text
1. 外层 Recipe propose planner Activation
     expected_output = sub_plan Artifact        ← 计划"数据"，非控制流

2. planner 运行，产出 sub_plan:
     { discussants: [strategist, decomposer, critic], mode: "independent+aggregate" }
   ↑ Artifact（数据），满足"Agent 产数据不产控制流"

3. decide(Recipe, fold) 看到 sub_plan，展开:
     propose [Activation(strategist), Activation(decomposer), Activation(critic),
              Activation(aggregator, input=[三输出])]
     每个标 parent = planner.Activation          ← Activation 树

4. 子 Activation 进同一 Session，Scheduler 调度 / Capability 约束 / 写 Event
```

#### Recipe 的两半（嵌套成立的关键）

```text
决策:  读 state、产"下一步要做什么"     ← 由承担 Recipe 职责的 Agent 产出 (plan Artifact)
展开:  把 plan 转成真正的 Activation 提议 ← 由 Recipe 代码 (内核展开器) 完成
```

**Agent 做 Recipe 的大脑，Recipe 代码做 Recipe 的手脚。** 守住这条边界，铁律不被破坏（Agent 不直接获得控制流）。

#### 强推论：人工编排与自主规划在嵌套上同构

```text
人工编排 (Deterministic):   plan 是人预先写在 Recipe 代码里     ┐
                                                              ├─ 同一通用展开器
自主规划 (Agentic):          plan 由 Agent 动态产出 Artifact      ┘   + Activation 树 + Policy
```

差异只在"plan 从哪来"，展开、挂 parent、过 gate、进 Session 的工序完全一样。Recipe 可写成通用展开器（读 plan Artifact、展开子 Activation），不必预知所有结构——嵌套结构可由下层 Agent 动态产生。

#### 安全边界

承担 Recipe 决策的 Agent 是**被沙箱化的提议者**：
- 输出只能是 plan schema（受限数据），不是任意动作；
- 只提议、不执行；执行权与 gate 仍在 Policy / Scheduler；
- 它提议的子 Activation **每一个都要再过 Policy gate**。

**Policy 是嵌套安全的唯一守护者**：`budget_gate` 把全局预算在子 Activation 间分摊，卡死递归深度；`stop_condition` 检测循环；gate 对所有子 Activation 生效，包括动态展开的。没有 Policy，嵌套是无限生长的树；有了 Policy，嵌套是有界、可审计、可恢复的树。

---

### 案例 D：对抗性升级（Policy 按需触发）

**问题**：何时上 reviewer panel / judge / adversary？默认该多重？

**原语表达**：默认路径 = 单 Activation + schema 输出 + 确定性 policy check。升级路径由 Policy 的 `escalation_rules` 按信号触发：

| 触发信号 | 升级路径 |
| --- | --- |
| 高风险文件 / 破坏性操作 | 追加独立 Reviewer Activation |
| evaluator confidence 低 | 追加 fix Activation（首轮）→ 连续多轮 → escalate 到 reviewer panel |
| Actor 输出自相矛盾 / 多判断分歧 | Aggregation Activation + 投票 |
| 多轮失败 | escalate 或 stop |
| 用户预算允许 | 允许更深路径 |

对抗性的原语级支撑（均为六原语组合，非新原语）：

```text
Generator Activation ──► change artifact
Reviewer A/B/C (Independent Activations, 不共享中间上下文) ──► critique artifacts
Adversary Activation ──► 尝试证伪最强 claim
Aggregation Activation ──► 汇总 + 处理分歧 + 要求补证据
Policy ──► pass / fix / ask more / stop
```

**关键点**：复杂度控制是 Policy 的核心职责（不变量 8）。默认轻，按风险/失败/分歧/上下文压力展开。

---

## 八、一句话

> 六原语 = Activation（执行）+ Capability（约束）+ Artifact（状态）+ Event（事实）+ Recipe（编排）+ Policy（裁决）。`decide` 与 `gate` 只读 `fold(events, artifacts)`、永不直接调模型；Agent 产数据不产控制流。并发、流水线、人工编排、嵌套、对抗性审查全部是这六个原语的组合——`Session` 是视图，`Actor` 是 `target`，`Scheduler` 是内核模块，循环是读 state 的结果，嵌套是 Activation 的 `parent/child` 树。**框架到此收敛，无需第七个原语。**
