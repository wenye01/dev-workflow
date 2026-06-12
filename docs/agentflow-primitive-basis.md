# agentflow 原语基底：面向多 Agent 协作的长期框架

> 生成日期：2026-06-12
> 性质：框架原语设计。本文不讨论当前实现路线、roadmap 或阶段落地，只回答一个问题：多 Agent 协作框架中，哪些能力应被视为长期稳定的原子。

---

## 一、核心判断

agentflow 的目标不是把若干命令、脚本和模型调用拼成 pipeline，而是构建一个能承载长期多 Agent 协作的框架。

因此，框架的原语不应从“所有执行动作都长得像一个 Step”出发，而应从多 Agent 协作的本质出发：

> **Agent 是语义中心，Activation 是内核可见的执行边界。**

Agent 是被委派工作的自主执行者。它可能在内部调用 bash、读写文件、运行测试、调用工具、反复思考。这些内部动作不一定由内核逐条调度。

内核真正需要管理的是：

- 何时把一个目标交给哪个 Agent；
- 交给它哪些上下文、权限和资源；
- 它必须产出哪些可校验工件；
- 它的生命周期如何记录；
- 它的结果如何成为后续协作的输入。

这一次受控委派，就是 **Activation**。

---

## 二、为什么不是 Step

把 `agent`、`command`、`transform` 都拉平成同级 `Step`，在运行时机制上有吸引力：统一 cache、resume、budget、event、sandbox。

但在多 Agent 框架里，这个抽象会掩盖一个关键事实：

> Agent 不是普通动作。Agent 是能自主展开动作、使用工具、形成判断、产出 handoff 的协作主体。

Agent 内部可能执行许多命令，但这些命令属于 Agent 的执行轨迹，不天然成为内核调度原语。

需要区分两类边界：

```text
Kernel-managed Activation
  内核把目标、上下文、权限和期望输出交给某个 Agent 或系统能力。

Agent-internal Tool Use
  Agent 在自己的执行环境里调用 bash、工具、MCP、测试命令等。
```

只有当命令、验证、变换由 recipe/kernel 直接发起时，它才进入内核边界，成为一种系统 Activation。

```text
Generator Agent 内部运行 npm test
  => AgentActivation 的内部 trace，不是独立内核原语。

Recipe 要求独立执行 npm test 作为质量门
  => SystemActivation，可被内核记录、限制、复用和调度。
```

所以更准确的表达不是“所有 Step 平等”，而是：

> **Activation 是运行时边界；AgentActivation 是最重要、最丰富的 Activation。**

---

## 三、原语集合

多 Agent 框架的稳定基底由七个原语组成：

```text
Agent
Activation
Artifact
Event
Capability
Session
Recipe
```

它们的职责分别是：

| 原语 | 含义 | 不应承担的职责 |
| --- | --- | --- |
| Agent | 可被委派工作的自主执行者 | 不直接等同于一次执行 |
| Activation | 一次受控执行边界 | 不要求暴露 Agent 内部每个工具动作 |
| Artifact | 跨边界传递的稳定内容 | 不承载未结构化的隐式状态 |
| Event | append-only 的事实记录 | 不作为可随意修改的状态表 |
| Capability | 权限、资源和能力授予 | 不等同于业务计划 |
| Session | 长期协作过程的事实命名空间 | 不等同于模型上下文窗口 |
| Recipe | 组织协作的控制策略 | 不绕过 policy、capability 和 event log |

---

## 四、Agent

**Agent** 是多 Agent 框架的一等业务对象。

它表示一个可被委派工作的自主执行者，通常包含：

- role：例如 planner、generator、evaluator、reviewer、critic、fixer；
- executor：模型、provider、human、local program 或混合执行器；
- context strategy：如何装载上下文、历史和输入工件；
- tool policy：可用工具集合和默认权限；
- output contract：默认产出类型、schema 和 handoff 约定；
- memory/session policy：是否延续会话、何时重置上下文。

Agent 的关键特征是**内部自主性**。它可以在一次 Activation 中自行分解任务、调用工具、尝试修复、运行命令、总结结果。

内核不应假设 Agent 内部每一步都需要被框架调度。内核只要求 Agent 在 Activation 边界上服从统一协议：输入、权限、事件、输出、失败状态。

---

## 五、Activation

**Activation** 是内核可见的最小执行边界。

它回答的问题是：

> 在当前 Session 中，框架要把什么目标交给谁，在什么权限下执行，并期待什么工件回来？

Activation 可以有不同类型：

```text
AgentActivation
  委派给 Agent 的自主执行。

SystemActivation
  由 kernel/recipe 直接发起的系统动作，例如 command、verify、transform。

HumanActivation
  需要人工判断、批准、选择或输入的边界。
```

AgentActivation 是多 Agent 协作的主路径。SystemActivation 只在内核或 recipe 需要直接控制某个系统动作时出现。

一个 Activation 至少应表达：

- activation id；
- target agent 或 system capability；
- objective；
- input artifacts；
- expected output artifacts；
- capability grants；
- parent activation；
- dependency hints；
- resource scope；
- lifecycle policy，例如 timeout、cancellation、retry 上限；
- budget class；
- metadata，例如 recipe、phase、group、priority。

Activation 不是调度算法本身。它只是为未来调度预留足够表达力。

---

## 六、Artifact

**Artifact** 是唯一稳定跨边界状态。

Agent 可以在内部持有上下文、scratchpad、命令输出和中间判断，但只要这些内容要影响其他 Agent、Recipe 或后续恢复，就必须成为 Artifact。

Artifact 应具备：

- ref：稳定引用路径；
- schema id：明确结构；
- content hash：内容寻址；
- producer：由哪个 Activation 产出；
- input refs：依赖了哪些输入；
- payload：结构化内容；
- optional views：markdown、summary、human-readable rendering。

常见 Artifact 包括：

- task；
- project index；
- planner package；
- contract；
- role input；
- role output；
- change package；
- evaluator report；
- decision；
- handoff；
- final report。

handoff 不是独立原语：

```text
handoff = Artifact + Event + next Activation input
```

---

## 七、Event

**Event** 是 append-only 的事实记录。

Session 的真相来源不是模型上下文，也不是某个内存对象，而是 EventLog 与 ArtifactStore。

典型事件包括：

```text
session.started
recipe.selected
decision.recorded
activation.requested
activation.started
activation.completed
activation.failed
artifact.written
capability.granted
capability.revoked
budget.charged
human.approved
session.completed
session.stopped
```

Agent 内部工具动作是否进入 EventLog，取决于其重要性和可观测策略：

- 如果只是 Agent 内部尝试，可以作为 trace 附属于 AgentActivation；
- 如果影响跨 Agent 状态，必须产出 Artifact 或 Event；
- 如果涉及权限、安全、资源或外部副作用，必须至少被记录为 Event。

EventLog 的价值不只是审计，还包括：

- 恢复；
- 调试；
- UI 进度；
- 成本核算；
- 失败定位；
- 后续 recipe replay 或 continuation。

---

## 八、Capability

**Capability** 表示一次 Activation 被授予的能力、资源和权限。

多 Agent 框架不能只靠 prompt 约束 Agent。Agent 能做什么，必须在 Activation 边界上显式表达。

Capability 可以覆盖：

- readable artifact refs；
- writable artifact refs；
- file read scope；
- file write scope；
- shell access；
- network access；
- MCP tools；
- browser access；
- credential scope；
- worktree/container lease；
- external API quota；
- human approval requirement；
- wall time / token / call budget。

Capability 的作用是把“允许做什么”从自然语言中剥离出来，使其成为内核可检查的边界。

这并不要求内核管理 Agent 内部的每条 bash 命令。它只要求 Agent 的执行环境被限制在 Capability 授予的范围内。

---

## 九、Session

**Session** 是长期协作过程的命名空间。

它由两部分组成：

```text
Session = EventLog + ArtifactStore
```

Session 不是模型上下文窗口。模型上下文可以被压缩、重置、丢弃或重新构建；Session 必须长期稳定。

Session 支撑：

- 多 Agent 之间的共享事实；
- 跨上下文窗口的长期任务；
- 中断后的恢复；
- 多轮 handoff；
- UI 和报告；
- 后续审计。

一个 AgentActivation 可以选择延续某个模型会话，也可以每次 fresh start。但这只是执行策略，不是框架状态本身。

---

## 十、Recipe

**Recipe** 是组织多 Agent 协作的控制策略。

它读取 SessionState，提出新的 Activation，直到 Done 或 Stop。

Recipe 可以有不同信任等级：

```text
Deterministic Recipe
  受信任代码。读取 state，确定性地产生 activations。

Recorded Dynamic Recipe
  可包含 LLM、human 或动态控制，但每次 decision 必须记录为 Event。

Agentic Proposal
  Agent 可以提出下一步动作，但必须经过 policy/capability/scheduler gate。
```

因此，框架不必禁止动态控制流。更重要的是：

> 动态决策必须外显为 Event；恢复时可以 replay 已记录 decision，而不是重新生成。

Recipe 不应绕过：

- artifact schema；
- capability boundary；
- budget；
- event log；
- sandbox/resource policy；
- human approval policy。

LLM 可以生成计划、unit list、workflow spec 或 proposed actions，但不应直接获得无限制可执行控制流。

---

## 十一、原语之间的关系

核心循环如下：

```text
Session(EventLog + ArtifactStore)
        ↓
Recipe reads SessionState
        ↓
Recipe proposes Activation
        ↓
Policy/Scheduler admits Activation
        ↓
Activation runs Agent or System capability
        ↓
Agent internally uses tools within Capability
        ↓
Activation emits Events and writes Artifacts
        ↓
Session updates
```

用关系表达：

```text
Recipe
  reads SessionState
  proposes Activations

Activation
  targets Agent or System capability
  reads Artifacts
  holds Capability grants
  emits Events
  writes Artifacts

Agent
  executes within Activation boundary
  may use internal tools
  must return boundary outputs

Artifact
  becomes input for later Activations
  carries contracts, handoffs, evidence and decisions

Event
  records facts
  folds into SessionState

Capability
  constrains Activation
  defines permissions and resources

Session
  stores all durable facts
```

---

## 十二、推导出的非原语

许多常见功能不是基底原语，而是由上述原语组合得到。

| 功能 | 原语解释 |
| --- | --- |
| handoff | Artifact + Event + next Activation input |
| parallel | 多个 Activation 同时 ready 且 capability/resource 不冲突 |
| pipeline | 一个 Activation 的 Artifact 成为另一个 Activation 的输入 |
| review panel | 多个 Reviewer Activations 读取同一 Artifact，再由 Aggregator Activation 汇总 |
| evaluator loop | Generator/Evaluator Activations + decision events + budget |
| cache | Activation input/artifact/capability/executor version 的稳定 key |
| resume | EventLog fold 出 SessionState，再继续未完成 Activation |
| phase | Event metadata 或 Activation group |
| budget | Capability/Policy 对 Activation 的约束 |
| sandbox | Capability 的资源授予与执行环境 |

这些功能可以在上层提供友好 API，但不应膨胀为内核原语。

---

## 十三、调度的暂留位置

调度很重要，但它不是本文展开的重点。

当前只保留边界判断：

> Scheduler 是解释 Activation 依赖、Capability、资源冲突和生命周期策略的内核模块。

Activation 必须预留调度所需的信息：

- dependencies；
- input artifacts；
- expected outputs；
- resource scope；
- capability grants；
- parent/child activation；
- priority/group；
- timeout/cancellation/retry policy。

未来可以在 Scheduler 中展开：

- 并行与串行；
- 文件写锁；
- worktree/container lease；
- data parallel；
- cognitive parallel；
- cancellation；
- retry；
- merge；
- backpressure；
- fairness；
- budget-aware scheduling。

但这些不改变原语基底。

---

## 十四、关键不变量

1. **Agent 是语义中心。**
   多 Agent 框架的核心对象是 Agent，而不是 command 或泛化 Step。

2. **Activation 是运行时边界。**
   内核管理一次受控委派，而不是 Agent 内部每个工具动作。

3. **Artifact 是跨边界状态。**
   任何要影响其他 Agent、Recipe 或恢复流程的内容，都必须 artifact 化。

4. **Event 是事实来源。**
   所有重要生命周期、决策、权限和产物都必须进入 append-only log。

5. **Capability 是权限边界。**
   prompt 不是安全边界；能力授予必须结构化。

6. **Session 独立于模型上下文。**
   上下文可以重置，Session 必须可恢复。

7. **Recipe 组织协作，但不能绕过内核边界。**
   动态控制可以存在，但必须被记录、受限和可审计。

---

## 十五、一句话

> 多 Agent 框架的真正原子不是 command，也不是泛化 Step，而是“对自主 Agent 的受控 Activation”。Agent 通过 Artifact 交接，通过 Event 留痕，通过 Capability 受限，通过 Recipe 组织成长期协作，并在 Session 中形成可恢复、可审计的事实历史。
