# agentflow 内核设计：从原语推导的框架

> 生成日期：2026-06-12
> 性质：第一性原理设计。本文不依赖现有代码、roadmap 或既有方案，从"不可再分的原子是什么"出发，推导一个 agent workflow 框架。
> 关联文档：[claude-code-dynamic-workflow.md](./claude-code-dynamic-workflow.md)、[dynamic-workflow-direction.md](./dynamic-workflow-direction.md)、[roadmap.md](./roadmap.md)

---

## 一、先找原子：从力出发

一个编排 LLM 跑长任务的框架，受这几个不可回避的"力"约束：

1. 一次 agent 调用是**非确定、昂贵、会失败**的 —— 这是要被管理的原子事实。
2. 长任务**超出单个上下文窗口** —— 状态必须外置。
3. 质量是主观的 —— 必须被转成**可校验的工件**。
4. 工作可并行，但**有依赖、有共享资源冲突**。
5. 会中断 —— 必须**可恢复**。
6. 预算有限 —— 深度必须**有界**。

从这些力推导，多数人会把 `agent()` 当原子。**这是错的。** 真正的原子在更下一层。

---

## 二、真正的原子：Step（内容寻址的一次记录性工作）

`agent()` 只是 Step 的一个**种类**。原子是：

> **Step** = 一次由 `key = hash(kind, code_version, 输入工件哈希, 参数)` 唯一标识的工作；声明自己的副作用（读/写/隔离/scope）；产出 typed artifact；由 runtime 按 key 记忆化（memoize）。

为什么原子是 Step 而不是 agent：因为 **cache、resume、event log、budget、隔离这些机制必须均匀地挂在"一次工作"上**。如果只有 agent 调用是一等公民，那验证命令、文件变换、纯计算就享受不到同样的缓存/重放/记账，框架就会出现两套规则。把"问 LLM"、"跑命令"、"纯变换"统一成同一种 Step，整个模型才自洽。

- `kind=agent` 的 Step：body 是"问一个外部模型"。
- `kind=command` 的 Step：body 是"跑验证命令"。
- `kind=transform` 的 Step：body 是"纯函数变换工件"。

**runtime 唯一的不纯操作 = "执行一个不在 cache 里的 Step"。** 别的全是纯的。

---

## 三、围绕 Step 的不可再分原语集（7 个）

1. **Artifact** —— 不可变、内容寻址、schema 绑定的值。是**唯一能跨 Step 边界的东西**。
2. **Step** —— 上面那个原子。
3. **Event** —— append-only 的事实日志（`step.requested/started/succeeded/failed`、`artifact.written`、`budget.charged`、`decision.made`）。这就是 managed-agents 说的"会话"。
4. **Decision** —— 纯函数 `state → Directive`，`Directive ∈ {Run(steps[]), Done(result), Stop(reason)}`。这是"大脑"，但**它是可重放的纯函数**。
5. **Scheduler** —— 把 `Run(steps[])` 在依赖就绪 / 并发上限 / 资源锁 / 预算约束下跑起来。recipe 看不到它，它是内核。
6. **Budget/Lease** —— 按 Step 种类扣额度（先 call 数 / wall time，后 token）；耗尽即强制 `Stop`。
7. **Sandbox** —— Step 可申请的隔离上下文（`none|worktree|container`），是一种资源锁；cattle：按需开、用完弃、resume 时由工件重建。

**就这 7 个。** 没有 `parallel`、没有 `pipeline`、没有 `phase`、没有 `cache` —— 它们都不是原语，是推论（见第六节）。

---

## 四、框架的中心结构：事件溯源的归约循环

把上面拼起来，框架的本质是一个**对 event log 的确定性 reducer**：

```text
state = fold(event_log)                          // 状态 = 日志的纯折叠
loop:
  directive = Decision(state)                    // 纯：决定下一步
  if directive is Done/Stop: break
  ready = Scheduler.pick(directive.steps, state) // 依赖/锁/预算
  for step in ready (并发):
     if step.key in cache: emit step.succeeded(cached)  // resume 白拿
     else: result = execute(step); emit events          // 唯一不纯点
  state = fold(event_log)                        // 重新折叠，继续
```

这套结构里藏着**三条正交的轴**，框架的全部优雅就在于把它们彻底分开：

| 轴 | 是什么 | 性质 |
| --- | --- | --- |
| **决定做什么** | Decision | 纯、可重放、**无需任何 provider 就能单测** |
| **去做** | Step 执行 | 不纯、隔离、唯一容纳 IO 与非确定性的地方 |
| **记住** | Event log + Artifact | append-only，唯一的状态来源 |

Claude Code 的"确定性脚本 + agent 叶子"其实是这套结构的一个**投影 / 语法糖**——一个带缓存 `agent()` 的 JS 脚本，只是"给定已缓存的东西、接下来跑什么"的一种写法。事件溯源 reducer 更底层，且对 resume / 并发 / 分支的处理更严谨。

---

## 五、那条让一切成立的唯一铁律

> **Decision 只能读 Artifact，永远不能直接调模型。**

这是最深的一点。如果 recipe 想"根据 evaluator 的判断决定要不要再来一轮"，那么 **evaluator 的判断本身必须先成为一个 Step 的产出工件**，于是这个分支就退化成对工件的纯函数判断。Decision 层永远不碰 LLM，所以即使整个 workflow 是"AI 驱动"的，编排决策依然 100% 可重放。

这条铁律顺带**强制**了一个结论（不是偏好，是推论）：**recipe 不能是 LLM 即时生成的可执行脚本**——因为无法保证 LLM 生成的代码是纯的、可分析的，它会破坏 Decision 层的纯性。所以 recipe 必须是仓库内、可审、可静态分析的代码。LLM 能产的只有**数据**（选哪个 recipe、参数、unit 列表），不能产**控制流**。

---

## 六、所有"功能"如何退化成这 7 个原语

| 素材里的概念 | 在本框架里是什么 |
| --- | --- |
| `agent()` | `kind=agent` 的 Step |
| `parallel()`（barrier） | Decision 返回 `Run([...])` + 一个 join 标记 |
| `pipeline()`（无 barrier） | Decision 对每个 item 持续吐下一步，reducer 天然让各 item 独立推进 |
| `phase()` / `log()` | Event |
| cache / resume | Step 记忆化 + 日志重放（**白拿，不是功能**） |
| worktree 隔离 | Step 申请 Sandbox lease |
| planner/generator/evaluator GAN 循环 | 一个 Decision 函数（recipe #1），在循环里吐这些 Step |
| 契约协商 / 分级评分 / adversarial verify | 高阶 Decision 组合子：编排若干 agent-Step，再对它们的 typed 工件做纯断言 |
| 预算驱动深度 | Budget 耗尽 → 强制 `Stop` |
| 上下文重置 + handoff | 起新 agent-Step（清空上下文）+ Decision 从日志重建指针 |
| managed-agents 脑/会话/手 | Decision / Event log / Step+Sandbox |
| Project Index、TASK 上下文 | 都是 Artifact |

整张表能合上，说明这 7 个原语的基是**完备且正交**的。

---

## 七、recipe 的书写面

内核只认一种东西：**Decision 函数（TS reducer）**。声明式 DAG / 状态机只是"读一个 graph 工件的 Decision 函数"，是库，不是内核。所以：

- 三角色 = 第一个 Decision 函数。
- 新增 review / bug-hunt / migration = 新写 Decision 函数，复用同一内核与同一组 quality 组合子。
- 质量模式 = 可复用的高阶 Decision 组合子库。

---

## 八、设计的三条不变量（全是推论，不是规定）

1. **可重放** = Decision 纯 + Step 按内容哈希记忆化。
2. **脑/手/会话解耦** = Decision / Step+Sandbox / Event log 三轴正交。
3. **recipe 是代码非数据** = 被 Decision 层纯性强制。

---

## 九、最小内核接口草图（TS 类型）

仅为展示"能否编译成型"，非最终实现。重点是体现第四节循环与第五节铁律。

```ts
// ---- Artifact：唯一跨 Step 边界的东西 ----
interface Artifact<T = unknown> {
  readonly ref: string;        // 逻辑路径，如 .agentflow/units/a/output.json
  readonly hash: string;       // 内容哈希，参与 Step key
  readonly schemaId: string;   // 绑定 schema，runtime 校验
  readonly value: T;           // typed payload
}

// ---- Step：内容寻址的原子工作 ----
type StepKind = 'agent' | 'command' | 'transform';

interface StepSpec {
  readonly kind: StepKind;
  readonly codeVersion: string;            // body 实现版本，参与 key
  readonly inputs: readonly Artifact[];     // 输入工件（其 hash 参与 key）
  readonly params: Readonly<Record<string, unknown>>;
  readonly outputSchemaId: string;          // 产物必须满足的 schema
  readonly effects: {
    readonly writes: readonly string[];     // file scope，用于锁
    readonly isolation: 'none' | 'worktree' | 'container';
    readonly costClass: string;             // 预算扣费类别
  };
}

// key = hash(kind, codeVersion, inputs.map(hash), params)
type StepKey = string;
declare function stepKey(spec: StepSpec): StepKey;

// 执行：runtime 唯一的不纯操作
interface StepResult {
  readonly status: 'succeeded' | 'failed';
  readonly output?: Artifact;
  readonly error?: { code: string; message: string };
}
type StepExecutor = (spec: StepSpec, sandbox: SandboxLease) => Promise<StepResult>;

// ---- Event：append-only 的唯一状态来源 ----
type Event =
  | { t: 'workflow.started'; runId: string; recipe: string; params: unknown }
  | { t: 'decision.made'; directive: 'run' | 'done' | 'stop'; stepKeys: StepKey[] }
  | { t: 'step.requested'; key: StepKey; spec: StepSpec }
  | { t: 'step.started'; key: StepKey }
  | { t: 'step.succeeded'; key: StepKey; output: Artifact; cached: boolean }
  | { t: 'step.failed'; key: StepKey; error: { code: string; message: string } }
  | { t: 'artifact.written'; ref: string; hash: string }
  | { t: 'budget.charged'; costClass: string; amount: number }
  | { t: 'workflow.completed'; result: unknown }
  | { t: 'workflow.stopped'; reason: string };

// ---- State：事件日志的纯折叠 ----
interface State {
  readonly runId: string;
  readonly artifacts: ReadonlyMap<string, Artifact>;     // ref -> artifact
  readonly stepResults: ReadonlyMap<StepKey, StepResult>;
  readonly budget: BudgetState;
}
declare function fold(events: readonly Event[]): State;

// ---- Decision：纯函数，只读 State（只读 Artifact），永不调模型 ----
type Directive =
  | { kind: 'run'; steps: readonly StepSpec[]; join?: boolean }
  | { kind: 'done'; result: unknown }
  | { kind: 'stop'; reason: string };

type Recipe = (state: State) => Directive;   // 这就是 recipe 的全部

// ---- Budget / Sandbox：内核侧约束 ----
interface BudgetState {
  remaining(costClass: string): number;      // <=0 时 Scheduler 强制 stop
}
interface SandboxLease {
  readonly path: string;                      // worktree/container 工作目录
  release(): Promise<void>;                   // cattle：用完即弃
}

// ---- Kernel：第四节那个归约循环 ----
interface Kernel {
  run(recipe: Recipe, init: {
    runId: string;
    seedArtifacts: readonly Artifact[];       // TASK、project index 等
    execute: StepExecutor;                    // 注入：agent/command/transform 执行器
  }): Promise<State>;
}
```

要点回读：

- `Recipe = (state) => Directive` 完整体现"Decision 只读工件、永不调模型"——签名里根本没有 provider/LLM 入口。
- `StepKey` 含 `inputs.map(hash)`，所以输入工件一变就 cache miss——resume 正确性的命门。
- `execute` 被注入到 `Kernel.run`，测试时传一个确定性 fake executor，整条 recipe 无需真实 provider 即可单测。
- `SandboxLease` 让隔离成为 Step 的能力，而非某个角色的特权。

---

## 十、一句话

> 框架的原子不是 `agent()`，而是**内容寻址、可记忆化的 Step**；框架的本体是**对 append-only 事件日志做归约的纯 Decision 循环**。把"决定 / 执行 / 记忆"三轴正交分开，并坚守"Decision 只读工件、永不调模型"这一条铁律——于是 cache、resume、并发、分支、多 recipe、脑手解耦全部成为推论而非特性。
