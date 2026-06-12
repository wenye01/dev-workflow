# agentflow 多 Agent 框架思考：原语、边界与复杂度控制

> 生成日期：2026-06-12
> 性质：框架层思考。本文不讨论当前落地路线、roadmap 或具体实现步骤，只讨论多 Agent 协作框架中哪些抽象应长期稳定，以及复杂能力应如何按需展开。

---

## 一、核心判断

agentflow 的长期目标不应是固定的 Planner / Generator / Evaluator harness，而应是一个能承载多种 harness、recipe 和质量模式的多 Agent 协作框架。

这个框架需要同时满足两个方向：@

1. **Agent 必须是一等公民。**
   多 Agent 框架的主角不是 command、transform 或泛化 step，而是可被委派工作的自主 Agent。

2. **内核必须有更底层的执行边界。**
   Agent 本身不是“一次任务”。一次任务是把某个目标、上下文、权限和输出契约交给某个执行主体，这个边界称为 Activation。

因此，最重要的区分是：

```text
Agent / Actor = 谁来做
Activation   = 在什么边界下做什么
Artifact     = 做完留下什么
Event        = 过程中发生了什么
Capability   = 被允许做什么
Session      = 长期事实在哪里
Recipe       = 下一步如何组织
Policy       = 何时允许、升级、停止
```

一句话：

> **Agent 是语义中心，Activation 是运行时中心，Session 是长期状态中心。**

---

## 二、为什么不能把所有东西都拉平成 Step

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
  => AgentActivation 的内部 trace。

Recipe 明确要求独立运行 npm test 作为质量门
  => SystemActivation，由内核管理。
```

所以更准确的说法不是“所有 Step 平等”，而是：

> **Activation 是统一运行时边界；AgentActivation 是最重要、最丰富的 Activation 类型。**

---

## 三、原语基底

建议的稳定原语是：

```text
Actor
Activation
Capability
Artifact
Event
Session
Recipe
Policy
```

其中 Agent 是最重要的 Actor 类型。

| 原语 | 含义 | 关键边界 |
| --- | --- | --- |
| Actor | 可被 Activation 调用的执行主体 | 不等于一次执行 |
| Activation | 一次受控执行事务 | 不暴露所有内部细节 |
| Capability | 权限、资源、工具和预算授予 | 不等于任务目标 |
| Artifact | 跨 Activation 的稳定状态 | 不保存隐式上下文 |
| Event | append-only 的事实记录 | 不作为可变状态表 |
| Session | EventLog + ArtifactStore | 不等于模型上下文 |
| Recipe | 组织 Activations 的协作策略 | 不绕过内核边界 |
| Policy | 权限、预算、升级和停止规则 | 不替代 Recipe |

---

## 四、Actor 与 Agent

**Actor** 是可被 Activation 调用的执行主体。

Actor 可以分为：

```text
AgentActor
  多轮、自主、可使用工具。Planner、Generator、Evaluator、Reviewer、Critic 等属于此类。

ModelActor
  受限 LLM 操作。用于路由、摘要、打分、分类、去重、schema repair 等。

SystemActor
  非 LLM 系统能力。比如 command、verify、transform、git operation、artifact render。

HumanActor
  人类审批、选择、澄清或验收。
```

这样可以避免两个错误：

1. 把所有 LLM 能力都塞进 Agent。
   一些 LLM 用法只是单次判断或摘要，不需要完整自主 Agent。

2. 把 Agent 降格成普通 command。
   Agent 是多轮、自主、可使用工具的协作主体，应保留一等语义地位。

Agent 是最重要的 Actor，因为多 Agent 框架的核心价值来自多个自主执行者之间的分工、质疑、补充和交接。

---

## 五、Activation

**Activation** 是一次真正的执行任务。

它回答的问题是：

> 在当前 Session 中，要把什么目标交给哪个 Actor，在什么权限下运行，期望它产出什么 Artifact？

Activation 至少应表达：

- id；
- target actor；
- objective；
- input artifacts；
- expected output artifacts；
- capability grants；
- parent activation；
- dependency hints；
- resource scope；
- lifecycle policy，例如 timeout、cancel、retry；
- budget class；
- metadata，例如 recipe、phase、group、priority。

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
Activation = 一次受控执行事务
```

---

## 六、Capability

Capability 和 Activation 不重复。

```text
Activation = 要做的一次工作
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
    "budget": {
      "max_tokens": 80000,
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
- token / wall time / call count；
- human approval requirement。

prompt 不是安全边界。Capability 才是结构化的权限边界。

---

## 七、Artifact 与 Agent 记忆问题

多 Agent 中常见问题是：

> 每个 Agent 被组装 context 启动，内部运行数轮后产出 Artifact 并结束。下一轮如果不满意重新启动，上一轮未固化的中间发现、假设、失败路径和思考会丢失。

这个问题不能靠“保存 Agent 的完整脑内过程”解决，也不能完全依赖 Agent 自己判断什么重要。

框架层的原则应是：

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

---

## 八、Event

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
artifact.written
capability.granted
capability.revoked
budget.charged
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

---

## 九、Session

Session 是长期协作过程的事实命名空间：

```text
Session = EventLog + ArtifactStore
```

Session 不是模型上下文窗口。

模型上下文可以被压缩、重置、替换或丢弃；Session 必须长期稳定。

Session 支撑：

- 多 Agent 共享事实；
- 跨上下文窗口任务；
- 中断恢复；
- 多轮 handoff；
- UI 和报告；
- 审计；
- 后续 replay 或 continuation。

AgentActivation 可以选择延续某个模型会话，也可以 fresh start。这是执行策略，不是框架状态本身。

---

## 十、Recipe

Recipe 是组织多 Agent 协作的控制策略。

它读取 SessionState，提出新的 Activations，直到 Done 或 Stop。

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

LLM 可以生成：

- recipe 选择；
- unit list；
- workflow spec；
- proposed actions；
- risk hints；
- quality pattern 建议。

但 LLM 不应直接获得无限制可执行控制流。它的输出应进入受限 schema，再由 Recipe / Policy / Scheduler 解释。

---

## 十一、Policy

Policy 决定什么时候允许、升级、拒绝或停止。

它不替代 Recipe，也不直接完成业务任务。

Policy 负责：

- 权限检查；
- capability gate；
- human approval gate；
- budget gate；
- risk gate；
- stop condition；
- escalation condition；
- disagreement handling；
- expensive pattern trigger。

最重要的一点是：

> 复杂能力应由 Policy 按需触发，而不是作为内核默认路径。

例如：

```text
默认路径:
  single AgentActivation
  schema output
  deterministic policy check

中等路径:
  generator -> evaluator -> fix

高成本路径:
  generator -> multiple reviewers -> adversary -> judge
```

触发高成本路径的条件可以是：

- 高风险文件或权限；
- 安全、迁移、数据破坏性操作；
- evaluator confidence low；
- 证据不足；
- 多轮失败；
- Actor 输出自相矛盾；
- 多个判断之间存在分歧；
- 用户预算允许。

---

## 十二、多 Agent 对抗性的原语支撑

多 Agent 的价值之一，是降低单个模型陷入误区、过度自信或路径依赖的风险。

这不应通过“所有地方都上多个模型”解决。原语层只需要支持这些能力：

```text
Independent Activations
  多个 Actor 独立读取同一输入，不共享中间上下文，避免互相污染。

Actor Diversity
  不同模型、prompt、角色、工具权限、视角。

Claim + Evidence Artifact
  Actor 不能只给结论，必须给证据引用。

Adversarial Activation
  专门以找错、反驳、证明不成立为目标。

Aggregation Activation
  汇总多个独立判断，处理分歧、投票、排序、要求补证据。

Policy Gate
  最终通过、停止或继续，不由单个模型直接裁决。
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

Policy
  -> pass / fix / ask for more evidence / stop
```

关键不是让系统默认变复杂，而是让框架能表达：

- 独立判断；
- 证据化结论；
- 分歧记录；
- 对抗性审查；
- 汇总裁决；
- 按风险升级。

---

## 十三、复杂度控制原则

为了避免框架臃肿，必须坚持：

> **原语提供能力，Recipe / Policy 决定何时使用。默认路径必须轻。**

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
  如何组合。

Policy 层:
  何时升级。

Budget 层:
  允许花多少钱。

Scheduler 层:
  如何安排并发、锁、取消、重试。
```

默认路径应接近单 Agent 成本。复杂性只在风险、失败、分歧、长上下文压力出现时按需展开。

---

## 十四、调度的暂留位置

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
- timeout / cancellation / retry policy。

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
- budget-aware scheduling。

但调度算法不改变原语基底。

---

## 十五、原语之间的关系

核心循环：

```text
Session(EventLog + ArtifactStore)
        ↓
Recipe reads SessionState
        ↓
Recipe proposes Activation
        ↓
Policy/Scheduler admits Activation
        ↓
Activation invokes Actor with Capability
        ↓
Actor runs within boundary
        ↓
Activation emits Events and writes Artifacts
        ↓
Session updates
```

关系展开：

```text
Actor
  is invoked by Activation
  may be AgentActor, ModelActor, SystemActor, HumanActor

Activation
  targets Actor
  reads Artifacts
  holds Capability grants
  emits Events
  writes Artifacts

Capability
  constrains Activation
  defines tools, resources, permissions and budgets

Artifact
  carries contracts, claims, evidence, handoff and results
  becomes input for later Activations

Event
  records facts
  folds into SessionState

Session
  stores all durable facts

Recipe
  organizes Activations

Policy
  gates and escalates Activations
```

---

## 十六、推导出的非原语

| 功能 | 原语解释 |
| --- | --- |
| handoff | Artifact + Event + next Activation input |
| memory | Artifact contract + selective trace + optional compression |
| parallel | 多个 Activation ready 且 capability/resource 不冲突 |
| pipeline | 前一 Activation 的 Artifact 成为后一 Activation 的输入 |
| review panel | 多个独立 Reviewer Activations + Aggregation Activation |
| adversarial verify | Critic/Adversary Activation + evidence checking + Policy |
| cache | Activation inputs、capability、actor/executor version、artifact hash 的稳定 key |
| resume | EventLog fold 出 SessionState，再继续未完成 Activation |
| phase | Event metadata 或 Activation group |
| sandbox | Capability 的资源授予与执行环境 |
| budget | Capability/Policy 对 Activation 的约束 |

这些能力可以有上层 API，但不需要成为内核原语。

---

## 十七、关键不变量

1. **Agent 是语义中心。**
   多 Agent 框架的主角是自主执行者，而不是命令或泛化 Step。

2. **Activation 是运行时边界。**
   内核管理一次受控委派，不管理 Agent 内部每个动作。

3. **Capability 是权限边界。**
   prompt 不是安全边界，能力授予必须结构化。

4. **Artifact 是跨边界状态。**
   任何要影响其他 Actor、Recipe 或恢复流程的内容，都必须被外化。

5. **Event 是事实来源。**
   重要生命周期、决策、权限和产物进入 append-only log。

6. **Session 独立于模型上下文。**
   上下文可以重置，Session 必须可恢复。

7. **LLM 能力不只存在于 Agent。**
   ModelActor 可以承载受限的路由、摘要、打分、分类和压缩。

8. **多模型对抗是 pattern，不是默认路径。**
   原语支持独立判断和分歧处理，但是否启用由 Policy/Recipe/Budget 决定。

9. **默认路径必须轻。**
   全量 trace、额外压缩、judge panel、adversarial review 都应按风险和预算触发。

10. **动态控制必须可审计。**
    LLM 或 human 可以参与控制，但 decision 必须记录为 Event，恢复时可 replay。

---

## 十八、一句话

> agentflow 的原语基底应以 Actor / Activation / Capability / Artifact / Event / Session / Recipe / Policy 为核心：Agent 是最重要的 Actor，Activation 是一次受控执行事务，Capability 约束它能做什么，Artifact 和 Event 承载长期事实，Recipe 组织协作，Policy 决定何时升级复杂度。框架应能承载多 Agent 对抗、记忆压缩和复杂调度，但默认路径必须轻，复杂性只在风险、失败、分歧或上下文压力出现时按需展开。
