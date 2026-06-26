# Claude Code 的 Dynamic Workflow 实现机制

> 记录 Claude Code 动态工作流系统的架构设计与核心实现原理。

## 1. 整体架构

```
用户请求 → 主循环 (main loop)
              ↓
         Workflow 工具调用
              ↓
         执行内联 JavaScript 脚本
              ↓
         通过 agent() 派生子 agent
              ↓
         子 agent 独立运行，返回结果
```

核心设计思想：**用确定性脚本控制流程，用 AI agent 执行具体任务**。

## 2. 脚本 DSL（JavaScript 子集）

每个 workflow 脚本必须是纯 JavaScript（非 TypeScript），以 `export const meta = {...}` 开头：

```javascript
export const meta = {
  name: 'review-changes',
  description: 'Review changed files across dimensions',
  phases: [
    { title: 'Scan', detail: 'grep for patterns' },
    { title: 'Verify', detail: 'adversarial check' },
  ],
}

// 脚本体 - 使用提供的原语
phase('Scan')
const bugs = await agent('find bugs', { schema: BUG_SCHEMA })

phase('Verify')
const verified = await parallel(
  bugs.map(b => () => agent(`verify: ${b.title}`, { schema: VERDICT_SCHEMA }))
)
```

## 3. 核心原语

| 原语 | 作用 | 并发模型 |
|------|------|----------|
| `agent(prompt, opts)` | 派生一个子 agent 执行任务 | 异步，返回 Promise |
| `parallel(thunks)` | 并行执行多个异步任务，**等待全部完成**（barrier） | 并发上限 = `min(16, cpu-2)` |
| `pipeline(items, stage1, stage2, ...)` | 流水线处理，每个 item 独立流过各阶段 | 无 barrier，item 间互不等待 |
| `phase(title)` | 声明新阶段，用于 UI 进度分组 | - |
| `log(message)` | 向用户输出进度消息 | - |

### `agent()` 的关键选项

- **`schema`**：传入 JSON Schema，强制子 agent 调用 `StructuredOutput` 工具返回结构化数据，外层直接拿到验证后的对象，无需解析
- **`isolation: 'worktree'`**：在独立 git worktree 中运行（用于并行写文件）
- **`phase`**：指定归属的阶段分组
- **`model`**：覆盖模型（一般不设，继承主循环模型）

## 4. 流水线 vs 屏障

```javascript
// pipeline — 默认推荐，无 barrier
// Item A 可能在 stage 3，Item B 还在 stage 1
const results = await pipeline(
  items,
  item => agent(`analyze ${item}`, { phase: 'Analyze' }),
  result => agent(`verify ${result.id}`, { phase: 'Verify' })
)

// parallel — barrier，必须等全部完成
const all = await parallel(items.map(i => () => agent(`process ${i}`)))
// 这里才能拿到完整结果做跨 item 操作
const deduped = dedupe(all)
```

## 5. 缓存与恢复（Resume）

- 每次调用 Workflow 会持久化脚本到文件，返回 `runId`
- **恢复机制**：用 `resumeFromRunId` 重启时，未修改的 `agent()` 调用直接返回缓存结果
- 原理：用 `(prompt, opts)` 作为缓存 key，只重跑编辑过或新增的调用
- 脚本中禁止 `Date.now()` / `Math.random()` / 无参 `new Date()`，因为它们会破坏确定性重放

## 6. 动态自 pacing（/loop 模式）

这是真正的"dynamic"部分 — 用户用 `/loop` 启动一个自驱动的循环任务：

```
/loop prompt → 用户无间隔启动
                ↓
          主循环执行 prompt
                ↓
          完成后调用 ScheduleWakeup(delaySeconds, prompt)
                ↓
          休眠 [60, 3600] 秒
                ↓
          定时器触发 → 重新执行 prompt → 循环
```

关键设计：

- **Cache TTL = 5分钟**：sleep < 300s 时缓存热，成本低；> 300s 时缓存冷，要重读上下文
- **自适应延迟**：不是固定间隔，模型根据情况选择下次唤醒时间
  - 活跃轮询外部状态（CI/CD）→ 60-270s（保持缓存热）
  - 等待慢变化 → 300-3600s
  - 空闲心跳 → 1200-1800s（20-30分钟）

## 7. Token 预算控制

```javascript
// budget 全局对象
budget.total      // 用户设定的总额度（如 +500k），null 表示无限制
budget.spent()    // 本轮已消耗的 token（含所有子 agent）
budget.remaining() // 剩余可用

// 用法：循环直到预算耗尽
while (budget.total && budget.remaining() > 50_000) {
  const result = await agent('find more bugs', { schema: BUGS_SCHEMA })
  bugs.push(...result.bugs)
  log(`${bugs.length} found, ${Math.round(budget.remaining()/1000)}k remaining`)
}
```

## 8. 质量模式（Quality Patterns）

Workflow 文档中内置了多种编排模式：

- **Adversarial Verify**：N 个独立"质疑者"投票，≥多数否决则丢弃发现
- **Judge Panel**：N 个独立方案评分，胜出者 + 亚军的好点子合成
- **Loop-until-dry**：持续发现直到连续 K 轮无新结果
- **Multi-modal Sweep**：多角度并行搜索（按容器/内容/实体/时间）
- **Completeness Critic**：最终 agent 检查"遗漏了什么"

## 9. 并发与资源限制

| 维度 | 限制 |
|------|------|
| 单 workflow 并发 agent 数 | `min(16, cpu_cores - 2)` |
| 单 workflow 生命周期 agent 总数 | 1000 |
| 单次 `parallel()`/`pipeline()` 项数 | 4096 |
| 自驱循环生命周期 | 7 天自动过期 |

## 10. 总结

Dynamic Workflow 的核心设计哲学：

1. **脚本是确定性编排层** — JavaScript 控制流程分支、循环、并行
2. **Agent 是智能执行层** — 每个 agent 独立拥有工具访问能力
3. **Cache + Resume 保证可重放** — 确定性原语 + 持久化脚本 = 可恢复
4. **Budget 驱动自适应** — 根据剩余 token 动态决定工作深度
5. **Pipeline 默认，Barrier 按需** — 最大化并行效率，仅在真正需要跨项同步时才等待

这种设计让 Claude Code 既能做简单的单 agent 任务，也能编排上百个子 agent 的大规模并行审查/迁移工作。
