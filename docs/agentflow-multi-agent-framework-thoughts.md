# agentflow 多 Agent 框架思考：原语、边界与复杂度控制

> 生成日期：2026-06-12  
> 性质：框架层思考。本文不讨论当前落地路线、roadmap 或具体实现步骤，只讨论多 Agent 协作框架中哪些抽象应长期稳定，以及复杂能力应如何按需展开。

---

## 0. 文档定位

本文的核心问题是：

> agentflow 如果要成为长期可扩展的多 Agent 协作框架，内核应该稳定哪些抽象，哪些能力应该留在上层策略中组合？

结论先行：

> **Agent 是语义中心，Activation 是运行时中心，Session 是长期状态中心；可重放来自 EventLog 的 record/replay，而不是假设 Agent 重新执行一定得到同一结果。**

本文按以下层级组织：

```text
框架目标
  -> 原语层
     -> Actor / Activation / Capability / Artifact / Event / Session / Recipe
  -> 运行时层
     -> Context Assembly / Scheduler / Runtime Guard / Cache / Resume / Budget Account
  -> 组合模式层
     -> Handoff / Review Panel / Adversarial Verify / Aggregation / Quality Escalation
  -> 复杂度控制
     -> 默认轻路径 / 按风险升级 / 副作用约束 / 可审计动态控制
```

---

## 1. 核心判断

agentflow 的长期目标不应是固定的 Planner / Generator / Evaluator harness，而应是一个能承载多种 harness、recipe 和质量模式的多 Agent 协作框架。

这个框架需要同时满足两个方向：

1. **Agent 必须是一等公民。**  
   多 Agent 框架的主角不是 command、transform 或泛化 step，而是可被委派工作的自主 Agent。

2. **内核必须有更底层的执行边界。**  
   Agent 本身不是“一次任务”。一次任务是把某个目标、上下文、权限和输出契约交给某个执行主体，这个边界称为 Activation。

最重要的区分是：

```text
Agent / Actor = 谁来做
Activation   = 在什么边界下做什么
Artifact     = 做完留下什么
Event        = 过程中发生了什么
Capability   = 被授予哪些能力边界
Session      = 长期事实在哪里
Recipe       = 下一步如何组织
```

Budget 不应放进原语基底。预算账户是更上层的运行管理机制，可以读取 EventLog、维护跨 Session / 用户 / 项目的额度，并向 Scheduler / Runtime Guard 提供约束。

---

## 2. 为什么不能把一切拉平成 Step

把 `agent`、`command`、`transform`、`verify` 都建模成同级 Step，有一个明显好处：cache、resume、event、budget、sandbox 可以复用同一套机制。

但在多 Agent 框架里，这会掩盖一个关键事实：

> Agent 不是普通动作。Agent 能自主展开动作、使用工具、形成判断、产出 handoff，并在一次调用中执行多轮内部循环。

Agent 内部可能会：

- 调用 bash；
- 读写文件；
- 跑测试；
- 调用 MCP 工具；
- 形成假设；
- 放弃若干路径；
- 反复修正方案；
- 最终产出 Artifact。

这些内部动作不一定由内核逐条管理。它们属于 AgentActivation 的内部执行轨迹。

因此需要区分两类边界：

```text
Kernel-managed Activation
  内核把目标、上下文、权限和期望输出交给某个 Actor。

Agent-internal Tool Use
  Agent 在自己的执行环境里使用 bash、工具、MCP、测试命令等。
```

例子：

```text
Generator Agent 内部运行 npm test
  -> AgentActivation 的内部 trace。

Recipe 明确要求独立运行 npm test 作为质量门
  -> SystemActivation，由内核管理。
```

所以更准确的说法不是“所有 Step 平等”，而是：

> **Activation 是统一运行时边界；AgentActivation 是最重要、最丰富的 Activation 类型。**

---

## 3. 总体层级

### 3.1 原语层

建议的稳定原语是：

```text
Actor
Activation
Capability
Artifact
Event
Session
Recipe
```

其中 Agent 是最重要的 Actor 类型。

| 原语       | 含义                                        | 关键边界                 |
| ---------- | ------------------------------------------- | ------------------------ |
| Actor      | 可被 Activation 调用的执行主体              | 不等于一次执行           |
| Activation | ActivationSpec + ActivationRun 的运行时边界 | 不暴露所有内部细节       |
| Capability | 权限、资源和工具授予                        | 不等于安全沙箱或任务目标 |
| Artifact   | 跨 Activation 的稳定状态                    | 不保存隐式上下文         |
| Event      | append-only 的事实记录                      | 不作为可变状态表         |
| Session    | EventLog + ArtifactStore                    | 不等于模型上下文         |
| Recipe     | 组织 ActivationSpecs 的协作策略             | 不绕过内核边界           |

### 3.2 运行时层

运行时层不是新的原语，而是解释和执行原语的机制。

| 机制             | 作用                                            | 依赖的原语                                |
| ---------------- | ----------------------------------------------- | ----------------------------------------- |
| Context Assembly | 从 SessionState 选择哪些事实进入本次 Actor 输入 | Session / Artifact / Event / Recipe       |
| Scheduler        | 解释依赖、资源、并发、生命周期和重试            | Activation / Capability / Event           |
| Runtime Guard    | 做不可绕过的准入、审批、锁、预算和副作用检查    | Activation / Capability / Session / Event |
| Cache            | 按 ActivationSpec 指纹复用历史产物              | Activation / Artifact / Event             |
| Resume           | 通过 EventLog + ArtifactStore 恢复 SessionState | Session / Event / Artifact                |
| Budget Account   | 维护跨 Session / 用户 / 项目的额度和停止条件    | Event / Session / Runtime Guard           |

### 3.3 组合模式层

多 Agent 对抗、review panel、judge、handoff、workflow strategy、quality strategy 都应是 Recipe 组合出的模式，而不是新的内核原语。

| 模式               | 原语表达                                                                  |
| ------------------ | ------------------------------------------------------------------------- |
| handoff            | Artifact + Event + next ActivationSpec input                              |
| pipeline           | 前一 ActivationRun 的 Artifact 成为后一 ActivationSpec 的输入             |
| review panel       | 多个独立 Reviewer ActivationSpecs + Aggregation ActivationSpec            |
| adversarial verify | Critic / Adversary ActivationSpec + evidence checking + Recipe acceptance |
| parallel           | 多个 ActivationSpecs ready 且 Capability / resource 不冲突                |
| phase              | Event metadata 或 Activation group                                        |

### 3.4 复杂度控制层

框架的默认路径必须轻。复杂能力只在风险、失败、分歧、长上下文压力或预算账户允许时展开。

不要把这些做成强制流程：

- 每个 Activation 后都跑 summarizer；
- 每个判断都用 judge panel；
- 每个 Agent 都多模型投票；
- 每个 trace 都进入上下文；
- 每个命令都提升为内核调度对象；
- 每个中间想法都 artifact 化。

更合理的分层是：

```text
原语层:
  表达能力。

Recipe 层:
  决定如何组合。

Budget Account / Run Manager 层:
  维护跨 Session / 用户 / 项目的额度、扣费和停止条件。

Scheduler / Runtime Guard 层:
  安排并发、锁、取消、重试、准入和强制停止。
```

---

## 4. 七个原语

### 4.1 Actor 与 Agent

**Actor** 是可被 Activation 调用的执行主体。

Actor 可以分为：

```text
AgentActor
  多轮、自主、可使用工具。
  Planner、Generator、Evaluator、Reviewer、Critic 等属于此类。

ModelActor
  受限 LLM 操作。
  用于路由、摘要、打分、分类、去重、schema repair 等。

SystemActor
  非 LLM 系统能力。
  比如 command、verify、transform、git operation、artifact render。

HumanActor
  人类审批、选择、澄清或验收。
```

这样可以避免两个错误：

1. **把所有 LLM 能力都塞进 Agent。**  
   一些 LLM 用法只是单次判断或摘要，不需要完整自主 Agent。

2. **把 Agent 降格成普通 command。**  
   Agent 是多轮、自主、可使用工具的协作主体，应保留一等语义地位。

Agent 是最重要的 Actor，因为多 Agent 框架的核心价值来自多个自主执行者之间的分工、质疑、补充和交接。

### 4.2 Activation：Spec 与 Run

**Activation** 至少包含两层：

```text
ActivationSpec = 一份尚未执行的受控委派请求
ActivationRun  = 针对某个 Spec 的一次实际执行事务或 attempt
```

ActivationSpec 回答的问题是：

> 在当前 Session 中，要把什么目标交给哪个 Actor，在什么权限下运行，期望它产出什么 Artifact？

ActivationSpec 至少应表达：

- id；
- target actor；
- objective；
- input artifacts；
- expected output artifacts；
- capability grants；
- parent activation；
- dependency hints；
- resource scope；
- lifecycle rules，例如 timeout、cancel、retry；
- effect class；
- accounting metadata，例如 cost class、priority、charge account hint；
- metadata，例如 recipe、phase、group、priority。

ActivationRun 承载一次真实执行：

- run id / attempt id；
- spec fingerprint；
- start / finish time；
- granted capability snapshot；
- context assembly version；
- emitted events；
- written artifacts；
- failure / cancellation reason；
- cache hit provenance。

同一个 Agent 可以被多次 Activation 启动：

```text
Agent:
  reviewer.security

Activation A:
  review auth module, readonly, output security_findings

Activation B:
  verify one finding, can run tests, output verdict

Activation C:
  challenge generator patch, readonly, output critique
```

因此：

```text
Agent = 可复用执行主体
ActivationSpec = 要求它做什么
ActivationRun = 这次到底如何执行、产出或失败
```

### 4.3 Capability

Capability 和 ActivationSpec 不重复。

```text
ActivationSpec = 要做的一次工作
Capability = 这次工作被允许使用什么能力
```

示例：

```json
{
  "activation": {
    "target_actor": "generator.implementer",
    "goal": "implement auth refresh fix",
    "inputs": ["planner_package", "contract"],
    "expected_outputs": ["change_package", "handoff"]
  },
  "capability": {
    "filesystem": {
      "read": ["src/**", "tests/**"],
      "write": ["src/auth/**", "tests/auth/**"]
    },
    "tools": ["bash", "git"],
    "network": false,
    "sandbox": "worktree",
    "runtime_limits": {
      "max_wall_time_sec": 1200
    }
  }
}
```

Capability 可以覆盖：

- artifact read/write；
- file read/write scope；
- shell access；
- MCP tools；
- browser；
- network；
- credentials；
- worktree/container lease；
- external API quota；
- human approval requirement。

prompt 不是安全边界。Capability 至少应成为结构化、可检查、可记录的能力边界。

但 Capability 不等同于 sandbox，也不要求所有声明都具备同等强度的 OS 级隔离。更准确的分层是：

```text
framework-enforced
  Artifact 读写 scope、事件记录、human approval、调度准入、文件写锁、worktree lease。

sandbox-strengthened
  文件系统隔离、network=false、shell scope、credential scope。
  这些能力在容器、受限进程或专用执行环境中才是硬边界。

advisory / risk signal
  当前环境无法强制拦截时，只能作为 prompt、审计、Runtime Guard 风险信号或人工确认信号。
```

agentflow 的底线不应是“声明了什么就拥有完美隔离”，而应是：

- 对框架可控资源强制执行；
- 对共享文件和 worktree 做锁与租约；
- 对高风险外部副作用要求审批或补偿策略；
- 对不能硬拦截的能力诚实标注为 advisory；
- 让每次授予、拒绝、越权尝试和副作用都可恢复、可审计。

### 4.4 Artifact

Artifact 是跨 Activation 的稳定状态。它承载 contract、claim、evidence、handoff、patch、report、verdict 等长期事实。

多 Agent 中常见问题是：

> 每个 Agent 被组装 context 启动，内部运行数轮后产出 Artifact 并结束。下一轮如果不满意重新启动，上一轮未固化的中间发现、假设、失败路径和思考会丢失。

这个问题不能靠“保存 Agent 的完整脑内过程”解决，也不能完全依赖 Agent 自己判断什么重要。

框架层原则是：

> **Agent 内部上下文不是系统状态。只有被外化为 Artifact 或 Event 的内容，才是多 Agent 框架的状态。**

但这不意味着要全量保存或每次都用另一个 Agent 压缩。更合理的是分层：

```text
Level 0: 不保存
  Agent 内部临时上下文，结束即丢。

Level 1: 结构化轻量事件
  activation.started/completed、artifact refs、命令退出码、变更文件列表、错误摘要。
  这类信息通常不进入模型上下文，只用于审计和恢复。

Level 2: 输出契约要求的少量字段
  assumptions、risks、evidence_refs、open_questions、handoff_summary。
  这是默认 durable memory。

Level 3: 按需 trace/handoff
  只在高风险、失败、分歧、长任务切换或 resume 前生成。

Level 4: LLM 压缩/整理
  只在上下文确实需要跨轮传递，且原始信息太多时触发。
```

关键点：

> **存下来不等于喂给模型。**

很多 trace 可以廉价落盘，例如：

```text
ran npm test -> failed
changed src/auth/session.ts
read contract.json
wrote change_package.json
```

这些不消耗 token。只有后续 Activation 需要时，Recipe 才选择相关片段进入 context。

默认情况下，AgentActivation 的输出契约可以要求少量 durable memory：

```json
{
  "result": "...",
  "evidence_refs": ["..."],
  "assumptions": ["..."],
  "risks": ["..."],
  "open_questions": ["..."],
  "handoff_summary": "..."
}
```

更昂贵的 MemoryExtractor、Critic、Compressor 应是可选 pattern，而不是内核默认流程。

### 4.5 Event

Event 是 append-only 的事实记录。

典型事件包括：

```text
session.started
recipe.selected
decision.recorded
activation.requested
activation.started
activation.completed
activation.failed
activation.cache_hit
artifact.written
capability.granted
capability.revoked
context.assembled
accounting.charged
human.approved
session.completed
session.stopped
```

Agent 内部工具动作是否进入 EventLog，取决于价值和成本：

- 涉及权限、安全、资源或外部副作用，应记录；
- 影响后续协作，应成为 Artifact 或 Event；
- 只是内部尝试，可以作为轻量 trace 或直接丢弃；
- 需要进入后续 context 时，才做选择性提取或压缩。

EventLog 的价值包括：

- 审计；
- 恢复；
- UI 进度；
- 成本核算；
- 失败定位；
- recipe replay；
- continuation。

Event 不应被理解成“全量思维记录”。它是事实记录。

### 4.6 Session

Session 是长期协作过程的事实命名空间：

```text
Session = EventLog + ArtifactStore
```

Session 不是模型上下文窗口。模型上下文可以被压缩、重置、替换或丢弃；Session 必须长期稳定。

Session 支撑：

- 多 Agent 共享事实；
- 跨上下文窗口任务；
- 中断恢复；
- 多轮 handoff；
- UI 和报告；
- 审计；
- 后续 replay 或 continuation。

AgentActivation 可以选择延续某个模型会话，也可以 fresh start。这是执行策略，不是框架状态本身。

### 4.7 Recipe

Recipe 是组织多 Agent 协作的控制策略。

它读取 SessionState，提出新的 ActivationSpecs，直到 Done 或 Stop。

Recipe 的职责是 **propose**：

- 选择协作模式；
- 组织 Agent / Model / System / Human Actors；
- 决定上下文装配策略；
- 把质量模式展开成具体 ActivationSpecs；
- 编码 workflow strategy / quality strategy，例如何时评审、对抗、汇总、返工或停止。

Recipe 可以有不同信任等级：

```text
Deterministic Recipe
  受信任代码。读取 state，确定性地产生 ActivationSpecs。

Recorded Dynamic Recipe
  可包含 LLM、human 或动态控制，但每次 decision 必须记录为 Event。

Agentic Proposal
  Agent 可以提出下一步动作，但必须经过 Capability / Scheduler / Runtime Guard。
```

因此，框架不必禁止动态控制流。更重要的是：

> 动态决策必须外显为 Event；恢复时可以 replay 已记录 decision，而不是重新生成。

LLM 可以生成：

- recipe 选择；
- unit list；
- workflow spec；
- proposed actions；
- risk hints；
- quality pattern 建议。

但 LLM 不应直接获得无限制可执行控制流。它的输出应进入受限 schema，再由 Recipe / Scheduler / Runtime Guard 解释。

复杂质量路径也属于 Recipe，而不是独立原语。例如：

```text
默认路径:
  single AgentActivation
  schema output
  runtime guard check

中等路径:
  generator -> evaluator -> fix

高成本路径:
  generator -> multiple reviewers -> adversary -> judge
```

Recipe 可以根据这些信号决定升级：

- 高风险文件或权限；
- 安全、迁移、数据破坏性操作；
- evaluator confidence low；
- 证据不足；
- 多轮失败；
- Actor 输出自相矛盾；
- 多个判断之间存在分歧；
- 上层预算账户允许。

---

## 5. 运行时机制

### 5.1 Context Assembly

Context Assembly 应被显式建模为关注点，但不必成为原语。它没有独立事实来源，只是把 Session 中的事实投影成某次 ActivationRun 的输入上下文。

需要区分两个层：

```text
持久层
  EventLog + ArtifactStore。廉价、append-only、长期保存，不默认进入模型上下文。

上下文装配层
  从 SessionState 中选择哪些 Artifact、Event 摘要、trace 片段和约束进入下一次 Actor 输入。
```

一个 Context Assembly 过程应至少说明：

- 读取了哪些 input Artifact；
- 选择了哪些 Event / trace 摘要；
- 排除了哪些高噪声或低可信内容；
- 为哪个 Actor / objective / output contract 装配；
- 受哪些 token、权限、risk 和 recency 约束；
- 使用了哪个 assembly strategy / version。

它的产物可以是 ephemeral context packet，也可以在高风险或调试场景下写成 Artifact。只要这次装配会影响后续 Actor 输出，就应记录 `context.assembled` 事件，至少包含引用、hash、strategy version 和摘要。

这样可以避免两个极端：

- EventLog 里存了很多事实，却没有人知道哪些事实被喂给了模型；
- Recipe 把上下文选择逻辑埋在 prompt 拼接里，无法审计、调优或复现。

### 5.2 Cache 与 Resume

agentflow 在 Activation 模型下采用的是 **record/replay**，不是 deterministic recompute。

这意味着：

```text
可重放 = 用同一 EventLog + ArtifactStore + 已记录的 dynamic decisions
        折叠出同一 SessionState，并从这个状态继续执行。

不可假设 = 重新执行同一个 AgentActivation 一定得到同一输出。
```

这和 kernel-design 中的 Step 模型不同。Step 模型里，内容寻址 key、纯 Decision 和 Step memoization 可以合成“输入变则 cache miss，输入不变则结果复用”的纯重算语义。Activation 模型承认 Agent、System command、Human approval、外部 API 都可能非确定，因此恢复的基础是事实记录，而不是重新运行历史。

resume 的语义应是：

1. fold EventLog，恢复 SessionState；
2. 已完成的 ActivationRun 以其已写 Artifact 为事实，不静默重跑；
3. 已记录的 dynamic decision 直接 replay，不重新询问 LLM 或 human；
4. 未完成、失败或取消的 ActivationRun 根据失败模型决定继续、重试、补偿或停止；
5. 如果外部世界已经变化，需要显式发起新的验证或重新执行 ActivationRun，而不是把历史 replay 解释成重新计算。

cache 的语义应按 Actor / effect class 区分：

```text
Pure/System deterministic Activation
  可以使用内容寻址 key 做真正的 memoization。

AgentActivation 或其他非确定 Activation
  cache 是对 ActivationSpec 指纹的产物复用：
  inputs hash + actor/executor version + capability snapshot + context assembly version + output contract。
```

非确定 Activation 的 cache hit 只表示“相同 spec 曾经产出过这些 Artifact，可以选择复用旧事实”。它不表示该 Actor 是纯函数，也不保证重新执行会得到相同结果。

因此，“同一个 activation 命中 cache”应更准确地写成：

> **某个 ActivationSpec 指纹命中历史 Artifact，当前生成一个 cached ActivationRun 事件并引用旧产物。**

如果用户、Recipe 或 Runtime Guard 要求重新验证，必须创建新的 ActivationRun attempt，记录其输入、原因、环境和产物。新 attempt 不覆盖旧事实。

### 5.3 Runtime Guard

独立准入层不再作为原语保留，但运行时仍然必须有不可绕过的准入检查。这个机制更适合叫 **Runtime Guard**，属于 Scheduler / Runner / RunManager 的一部分。

Runtime Guard 不组织业务流程，不决定多 Agent 拓扑，也不生成 reviewer / adversary / judge。它只解释已有原语和运行时 aggregate：

```text
RuntimeGuard(
  SessionState,
  candidate ActivationSpec,
  Capability,
  locks / leases,
  approvals,
  accounting aggregate,
  side-effect class
) -> admit | deny | require_human | stop
```

Runtime Guard 负责：

- Capability 是否覆盖请求的工具、文件、credential、network 和 artifact scope；
- 文件锁、worktree/container lease、并发资源是否可分配；
- human approval 是否已经以 Event 形式存在；
- Budget Account 是否允许本次 charge；
- side-effect class 是否允许自动执行或 retry；
- sandbox / advisory 能力是否和风险等级匹配；
- 已到达硬停止条件时强制 stop。

这些能力已经由七个原语覆盖：Capability 给出边界，ActivationSpec 声明需求和 effect class，Event 记录审批、扣费和事实，Session 提供 fold 后状态，Scheduler / Runner 负责不可绕过地执行检查。

### 5.4 Budget Account

预算账户不是原语。它可以是 Session / user / project / organization 级别的上层管理对象，通过 `accounting.charged` 等事件和外部计费数据形成 aggregate。

Runtime Guard / Scheduler 只读取这个 aggregate 做 gate；ActivationSpec 只携带 cost class、priority、charge account hint 等记账元数据。

这个拆分的意义是：

- 不把预算策略写死进内核原语；
- 支持跨 Session 和跨项目的额度管理；
- 允许不同部署使用不同 accounting 后端；
- 让预算扣费、拒绝和硬停止都成为可审计事实。

### 5.5 Scheduler

调度是多 Agent 框架的核心能力之一，但可以暂不做详细算法设计。

当前只需要明确：

> Scheduler 是解释 Activation 依赖、Capability、资源冲突和生命周期策略的内核模块。

Activation 应预留调度所需信息：

- dependencies；
- input artifacts；
- expected outputs；
- resource scope；
- capability grants；
- parent / child activation；
- priority / group；
- timeout / cancellation / retry rules。

未来 Scheduler 可以处理：

- 并行与串行；
- 文件写锁；
- worktree/container lease；
- data parallel；
- cognitive parallel；
- cancellation；
- retry；
- merge；
- backpressure；
- accounting-aware scheduling。

但调度算法不改变原语基底。

### 5.6 失败、重试与副作用

有副作用的失败模型不只属于 AgentActivation。SystemActivation 可以跑 migration，HumanActivation 可以批准外部动作，ModelActor 也可能调用带配额或写入效果的工具。只要 Activation 会改变世界，retry 就不是免费的。

ActivationSpec 应显式声明 effect class：

```text
pure / deterministic
  只读 Artifact 或做纯变换。失败后可安全重试或 memoize。

sandbox-contained
  副作用留在可丢弃 worktree/container 中。失败后可丢弃环境，从输入 Artifact 重新开始。

framework-managed
  写 Artifact、占文件锁、生成 patch、写临时工作区。需要事务边界、锁释放和 artifact status。

external-escaped
  git push、发布包、调用外部 API、写数据库、发送通知、执行不可逆迁移。
  不能盲目自动重试。
```

retry rules 应由 effect class 决定：

- `pure` 和明确幂等的 `SystemActivation` 可以自动 retry；
- `sandbox-contained` 可以通过丢弃 sandbox 后 retry；
- `framework-managed` 需要先恢复锁、清理临时状态或把部分产物标为 failed；
- `external-escaped` 必须要求 idempotency key、显式补偿动作或 human approval；
- 无法确认幂等时，默认 stop / require_human，而不是自动 retry。

每次 retry 都是新的 ActivationRun attempt。旧 attempt、部分副作用、错误和补偿动作都进入 EventLog；新的 attempt 不覆盖旧事实。

这样才能把“可恢复”限定在框架真实能恢复的范围内：worktree 可以丢弃，Artifact 可以标记和重建，文件锁可以释放；已经推送到远端、写入外部数据库或消耗外部 API 配额的副作用只能通过补偿、验证或人工决策处理。

---

## 6. 多 Agent 组合模式

### 6.1 多 Agent 对抗

多 Agent 的价值之一，是降低单个模型陷入误区、过度自信或路径依赖的风险。

这不应通过“所有地方都上多个模型”解决，也不需要引入新的多 Agent 原语。对抗、评审、汇总都应由原语组合表达：

```text
Independent Activations
  多个 ActivationSpecs 指向不同 Actor，读取同一输入 Artifact，不共享中间上下文。

Actor Diversity
  Actor metadata + Capability + Context Assembly strategy 的差异。

Claim + Evidence Artifact
  输出契约要求结论、证据引用、置信度和可反驳点。

Adversarial Activation
  普通 AgentActivation，只是 objective 是找错、反驳或证明不成立。

Aggregation Activation
  普通 ActivationSpec，输入是多个 critique / claim Artifacts，输出 disagreement report 或 verdict。

Recipe Acceptance
  Recipe 读取 evidence / disagreement / accounting aggregate，决定 pass、fix、ask for more evidence 或 stop。

Runtime Guard
  最终执行前仍检查 Capability、锁、审批、预算账户和副作用边界。
```

典型模式：

```text
Generator Activation
  -> change artifact

Reviewer A Activation
Reviewer B Activation
Reviewer C Activation
  -> independent critique artifacts

Adversary Activation
  -> tries to falsify strongest claim

Judge/Aggregator Activation
  -> compares claims + evidence + disagreement

Recipe
  -> pass / fix / ask for more evidence / stop
```

关键不是让系统默认变复杂，而是让框架能表达：

- 独立判断；
- 证据化结论；
- 分歧记录；
- 对抗性审查；
- 汇总裁决；
- 按风险升级。

### 6.2 推导出的非原语

这些能力可以有上层 API，但不需要成为内核原语。

| 功能               | 原语解释                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| handoff            | Artifact + Event + next ActivationSpec input                                                     |
| memory             | Artifact contract + selective trace + optional compression                                       |
| context assembly   | Recipe / Actor context strategy 从 SessionState 选择 Artifact/Event 片段，记录 context.assembled |
| parallel           | 多个 ActivationSpecs ready 且 capability/resource 不冲突                                         |
| pipeline           | 前一 ActivationRun 的 Artifact 成为后一 ActivationSpec 的输入                                    |
| review panel       | 多个独立 Reviewer ActivationSpecs + Aggregation ActivationSpec                                   |
| adversarial verify | Critic/Adversary ActivationSpec + evidence checking + Recipe acceptance                          |
| cache              | ActivationSpec 指纹命中历史 Artifact；非确定 Actor 只复用旧产物，不声明可纯重算                  |
| resume             | EventLog record/replay fold 出 SessionState，再按失败模型继续、重试、补偿或停止                  |
| phase              | Event metadata 或 Activation group                                                               |
| sandbox            | Capability 的执行环境强化，不等同于 Capability 本身                                              |
| budget             | 上层 Budget Account + accounting events + Scheduler/Runtime Guard gate                           |

---

## 7. 原语之间的关系

### 7.1 核心循环

```text
Session(EventLog + ArtifactStore)
        ↓
Recipe reads SessionState
        ↓
Recipe proposes ActivationSpec
        ↓
Scheduler / Runtime Guard admits ActivationSpec
        ↓
ActivationRun invokes Actor with Capability
        ↓
Actor runs within boundary
        ↓
ActivationRun emits Events and writes Artifacts
        ↓
Session updates
```

### 7.2 关系展开

```text
Actor
  is invoked by Activation
  may be AgentActor, ModelActor, SystemActor, HumanActor

ActivationSpec
  targets Actor
  reads Artifacts
  holds Capability grants

ActivationRun
  executes one admitted ActivationSpec
  emits Events
  writes Artifacts

Capability
  constrains ActivationSpec / ActivationRun
  defines tools, resources, permissions, locks and runtime limits

Artifact
  carries contracts, claims, evidence, handoff and results
  becomes input for later Activations

Event
  records facts
  folds into SessionState

Session
  stores all durable facts

Recipe
  organizes ActivationSpecs

Scheduler / Runtime Guard
  admits or denies ActivationSpecs by interpreting Capability, locks, approvals and accounting aggregates
```

---

## 8. 关键不变量

1. **Agent 是语义中心。**  
   多 Agent 框架的主角是自主执行者，而不是命令或泛化 Step。

2. **Activation 分为 Spec 与 Run。**  
   Spec 描述受控委派，Run 记录一次真实执行或 attempt。

3. **可重放是 record/replay。**  
   EventLog + ArtifactStore 是事实来源；重新执行是新的 Run，不是历史 replay。

4. **Capability 是能力契约，不等同于 sandbox。**  
   框架可控资源要强制执行；无法硬拦截的能力必须被标注、记录并进入风险 gate。

5. **Artifact 是跨边界状态。**  
   任何要影响其他 Actor、Recipe 或恢复流程的内容，都必须被外化。

6. **Event 是事实来源。**  
   重要生命周期、决策、权限和产物进入 append-only log。

7. **Session 独立于模型上下文。**  
   上下文可以重置，Session 必须可恢复。

8. **Context Assembly 必须显式可审计。**  
   存下来不等于喂给模型；进入上下文的事实、摘要和版本应可追踪。

9. **Recipe 组织策略，Runtime Guard 执行边界。**  
   Recipe 编码 workflow / quality strategy；Runtime Guard 解释 Capability、锁、审批、预算账户和副作用等级。

10. **LLM 能力不只存在于 Agent。**  
    ModelActor 可以承载受限的路由、摘要、打分、分类和压缩。

11. **多模型对抗是 pattern，不是默认路径。**  
    原语支持独立判断和分歧处理，但是否启用由 Recipe 和 Budget Account 决定。

12. **有副作用的 retry 必须受 effect class 约束。**  
    external-escaped 副作用需要幂等键、补偿或人工 gate，不能盲目自动重试。

13. **默认路径必须轻。**  
    全量 trace、额外压缩、judge panel、adversarial review 都应按风险和预算账户允许触发。

14. **动态控制必须可审计。**  
    LLM 或 human 可以参与控制，但 decision 必须记录为 Event，恢复时可 replay。

---

## 9. 一句话总结

> agentflow 的原语基底应以 Actor / Activation / Capability / Artifact / Event / Session / Recipe 七个原语为核心：Agent 是最重要的 Actor，Activation 分为可比较的 Spec 与可审计的 Run，Capability 是结构化能力契约而非 sandbox 本身，Artifact 和 Event 承载长期事实，Recipe 组织协作与质量策略。框架采用 EventLog record/replay 而非假设 Agent 可确定性重算；Runtime Guard、Context Assembly、预算账户、多 Agent 对抗、失败补偿和复杂调度都应由这七个原语组合表达，并只在风险、失败、分歧、上下文压力或预算允许时按需展开。
