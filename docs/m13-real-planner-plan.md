# M13 真实 Planner — 从确定性桩到 LLM 驱动

> 生成日期：2026-06-12
> 对应路线图：`docs/roadmap.md` M13
> 前置依赖：M12 编排主循环已完成

---

## Context

当前 `src/planner/planner-pipeline.ts` 是完全确定性的桩：
- `unitId = 'auth-refresh'` 写死，`batchId = 'batch-001'` 写死
- `buildPlannerPackagePayload()` 本地拼装 planner_package，不调用任何 LLM
- 不管 task 内容是什么，永远产出同一个 unit/batch/contract

本次改造将 Planner 变为真正的 LLM 驱动 pipeline，遵循 Generator/Evaluator 已有的 `AdapterManager.runRole()` 调用模式。**LLM 失败时直接抛 `PlannerPipelineError`，不做降级。**

### Planner 自身编排边界

本方案的目标是完成 M13 的最小真实 Planner：让 Planner 从确定性桩升级为单角色 LLM Planner，并产出可被后续 Generator/Evaluator 稳定消费的 canonical artifacts。

它能做到的是：
- Orchestrator 调用 `PlannerPipeline.build()`
- Planner 写入 router dispatch 和 role run request artifact
- Planner 调用单个 LLM role：`planner.initial`
- LLM 一次性产出完整 `planner_package`
- Pipeline 校验 schema 和 unit/batch/contract 引用一致性
- Pipeline 派生 `acceptance_contract`、`batch_schedule`、`run_state`、`unit_state`

因此，本方案能够支撑外部编排器调用 Planner，也能让 Planner 输出成为后续 pipeline 的稳定输入；但它还不是 Planner 内部多阶段编排。当前 `planner.initial` 同时承担任务理解、unit 拆分、contract 设计、batch 构建和风险识别职责，内部没有多 role DAG，也没有中间 planner artifact。

后续如果要让 Planner 自身具备更强的可组合、可扩展、可诊断能力，应进一步拆分为多角色编排，例如：
- `planner.analyzer`：理解任务、识别目标、约束和非目标
- `planner.decomposer`：拆分 execution units，判断依赖和 scope
- `planner.contract_designer`：生成验收标准和 verification strategy
- `planner.batch_builder`：安排 batch、parallelism 和 dependency order
- `planner.reviewer`：检查计划一致性、contract 可验证性、scope 是否过宽/过窄

这些角色的中间结果应 artifact 化，并由 Planner 内部 router/reviewer 汇总为最终 `planner_package`。M13 暂不实现该内部 DAG；本次只保留单 role 形态，为 M14+ 的 RouterRunner 或多角色 Planner 留出 artifact 和 metadata 追踪基础。

---

## 涉及文件

| 文件 | 改动类型 |
|------|---------|
| `src/planner/planner-pipeline.ts` | **主要改造**：移除确定性桩，增加 LLM 调用 |
| `src/config/config-loader.ts` | 默认配置新增 `planner.initial` 角色，避免无项目配置时 provider 选择失败 |
| `codeagent-wrapper/mock.go` | 新增 `planner_package` mock 场景 |
| `tests/planner/planner-pipeline.test.ts` | **新增**：Planner 专属测试 |
| `tests/generator/generator-pipeline.test.ts` | 更新 config：加 mock-planner provider |
| `tests/evaluator/evaluator-pipeline.test.ts` | 更新 config：加 mock-planner provider |
| `tests/cli/run-e2e.test.ts` | 更新 fixture wrapper：处理 `planner.initial` 角色 |

---

## 步骤

### Step 1：扩展 Go mock — `codeagent-wrapper/mock.go`

当前 mock 的 `ensureMockSchemaPayload()` 只填充 `role_output` schema 字段（changed_files, verification 等）。需要让 mock 在检测到 `planner.initial` 角色（通过 `cfg.Options["role"]`）时产出合法的 `planner_package`。

**改动**：
1. 在 `ensureMockSchemaPayload()` 开头加角色检测：若 `role == "planner.initial"`，调用新函数 `buildMockPlannerPackage(cfg, scenario)` 并直接返回
2. 新增 `buildMockPlannerPackage()` 函数，返回合法 JSON 字符串匹配 `agentflow.schema.llm.planner_package.v1`：
   - `goal`/`success_definition` 用固定文本
   - `units[0].ref` = `"auth-refresh"`（保持与现有测试一致）
   - `units[0].scope.allowed_paths` 从 `cfg.Options["allowed_paths"]` 提取，fallback 到 `["src/**", "tests/**"]`
   - `units[0].max_fix_rounds` = 1
   - `batches` = 单 batch 引用该 unit
   - `contracts` = 单 contract 含一条 `must` 验证标准，verification command 从 `cfg.Options` 读取或 fallback 到 `npm test`
   - `routing_hints`、`risks` 等填充空数组

**参考**：现有 `ensureMockSchemaPayload()` 在 `mock.go:79-113`，`mockChangedFiles()` 在 `mock.go:115-126`。

### Step 2：改造 `src/planner/planner-pipeline.ts`

#### 2a. 新增 imports

```ts
import { AdapterManager, AdapterSelectionError } from '../adapters/adapter-manager.js';
import { loadAgentflowConfig } from '../config/config-loader.js';
import { isRecord } from '../schemas/validator.js';  // 追加到已有 import
import { resolveArtifactRef } from '../artifacts/paths.js';  // 新增
```

#### 2b. 扩展 `PlannerPipelineOptions`

新增两个可选字段（与 Generator/Evaluator Options 对齐）：

```ts
readonly configPath?: string;
readonly onCliProcessStarted?: () => void;
```

#### 2c. 新增私有方法 `runPlannerRole()`

完全仿照 `GeneratorPipeline.runGeneratorRole()`（`generator-pipeline.ts:378-421`）：

- 加载 config → 创建 AdapterManager → 调 `runRole({ role: 'planner.initial', ... })`
- `AdapterSelectionError` → 包装成 `PlannerPipelineError(classification: 'provider_unavailable')`
- 其他错误直接抛
- **必须显式传 planner schema**：`CodeagentWrapperClient` 在有 `outputArtifact` 时默认使用 `llm.role_output.schema.json`，Planner 不能沿用默认值。`runRole()` 的 `metadata` 必须包含：

```ts
metadata: {
  outputSchemaPath: 'schemas/llm/llm.planner_package.schema.json',
  allowedPaths,
},
```

否则真实 provider 会被要求输出 `role_output` schema，mock 测试可能通过但真实 Planner 不工作。

#### 2d. 新增模块级辅助函数

- `plannerPrompt()` — 类似 `generatorPrompt()`，指示 LLM 读入 task/项目上下文并产出 `agentflow.schema.llm.planner_package.v1`
- `readPlannerPackagePayload(repoRoot, ref, registry, onSchemaFailure?)` — 读取 adapter 写入的文件，unwrap canonical envelope，用 `registry.assertLlmPayload('planner_package', payload)` 校验 schema；`SchemaValidationError` 时调用 `onSchemaFailure`
- `extractUnitId(payload)` — 从 `payload.units[0].ref` 提取，缺失时抛 `AGENTFLOW_PLANNER_UNIT_REF_MISSING`
- `extractBatchId(unitId)` — 返回 `${unitId}-batch`（MVP-1 单 batch，batch ID 是编排层确定性命名，不是 LLM 产物）
- `validatePlannerPackageSemantics(payload)` — schema 只保证字段形状，不保证引用一致。需要校验：
  - `units[0].ref` 存在
  - `batches[0].unit_refs[0] === units[0].ref`
  - `contracts[0].unit_ref === units[0].ref`
  - 不一致时抛 `PlannerPipelineError`，例如 `AGENTFLOW_PLANNER_PACKAGE_INCONSISTENT`

#### 2e. 重构 `build()` 方法体

**保留**（不需改的段落）：
- 预算 normalization（74-81）
- 读取 taskText、context artifacts（83-99）
- `buildRouterDispatchPayload()` 及其写入（120-148）
- `buildRoleRunRequestPayload()` 及其写入（150-185）
- acceptance contract 提取和写入（226-259 的逻辑）
- batch_schedule、run_state、unit_state 写入（261-363 的结构）
- 返回值构造（365-378）

**移除**：
- `const unitId = asUnitId('auth-refresh')` (101)
- `const batchId = 'batch-001'` (102)
- `buildPlannerPackagePayload()` 调用和 `registry.assertLlmPayload()` 调用（187-200）
- `selectVerificationCommand()` 调用（115-118）和整个 private 方法（380-412）——verification command 是 LLM 产物，不再是桩生成
- `buildPlannerPackagePayload()` 函数定义（481-563）

**新增**（替换 lines 187-200 的桩逻辑）：

```
const rawPlannerOutputRef = plannerPath('output.raw.json');

// role_run_request.output_artifact 必须指向 rawPlannerOutputRef；
// canonical planner package 仍写入 plannerPackageRef = .agentflow/planner/package.json。

const agentResult = await this.runPlannerRole({
  repoRoot, runId, configPath: options.configPath,
  outputArtifact: rawPlannerOutputRef,
  inputArtifacts: [task, projectIndexRef, worktreeStatus, selectedProjectContext, roleInputs[0]],
  onCliProcessStarted: options.onCliProcessStarted,
});

// 校验完成状态
if (agentResult.status !== 'completed' || !agentResult.outputArtifact) {
  throw PlannerPipelineError(AGENTFLOW_PLANNER_ROLE_FAILED, ...);
}

// 读取并校验 planner_package schema
const plannerPackagePayload = await readPlannerPackagePayload(
  repoRoot, agentResult.outputArtifact, this.registry, options.onSchemaFailure,
);
validatePlannerPackageSemantics(plannerPackagePayload);

// 从 LLM 产出中提取动态 ID
const unitId = extractUnitId(plannerPackagePayload);
const batchId = extractBatchId(unitId);
```

**延迟声明**：`acceptanceContractRef = unitContractPath(unitId)` 和 `unitStateRef = unitStatePath(unitId)` 必须移到 `unitId` 提取之后。

其余 artifact 写入（planner_package、acceptance_contract、batch_schedule、run_state、unit_state）的代码结构基本不变，只是 payload 来源从本地函数变为 LLM 产出，`unitId`/`batchId` 从硬编码变为动态提取。

**metadata 调整**：
- `planner_package` 的 producer 应从 router 桩调整为真实 role：

```ts
producer: {
  kind: 'role',
  module: 'planner',
  role: 'planner.initial',
  provider: agentResult.provider,
  model: agentResult.model,
}
```

- `planner_package` 的 `inputArtifacts` 应包含 `rawPlannerOutputRef` 和 planner role request ref，便于追踪真实 LLM 原始输出。

### Step 2f：更新默认配置 — `src/config/config-loader.ts`

当前 `DEFAULT_CONFIG.roles` 只有 `planner.router`，真实 Planner 改为调用 `planner.initial` 后，无项目配置运行会抛 `AdapterSelectionError`。

新增默认角色：

```ts
'planner.initial': {
  module: 'planner',
  write_permission: 'artifact_write',
  provider_candidates: [{ provider: 'codex' }],
},
```

保留 `planner.router`，因为当前 Context/Planner 仍会写 router dispatch artifact，M14 再统一替换为 RouterRunner。

### Step 3：更新现有测试 config

#### `tests/generator/generator-pipeline.test.ts`

在 `agentflowConfig()` 中增加 mock-planner provider 和 `planner.initial` 角色：

```yaml
providers:
  mock-planner:
    agent: mock
    model: mock-planner
  mock-generator:
    ... (existing)
roles:
  planner.initial:
    provider_candidates:
      - provider: mock-planner
        model: mock-planner
  generator.implementer:
    ... (existing)
```

#### `tests/evaluator/evaluator-pipeline.test.ts`

同上模式，增加 mock-planner provider 和 `planner.initial` 角色。

**原理**：这两个测试都调用 `PlannerPipeline().build()` 作为 setup 步骤。改造后 Planner 内部会调 `AdapterManager.runRole('planner.initial')`，如果 config 中没有这个角色的 provider 候选，会抛 `AdapterSelectionError`。

### Step 4：新增 `tests/planner/planner-pipeline.test.ts`

| 测试名 | 验证点 |
|--------|--------|
| `produces planner package with LLM-driven unit ref` | mock provider 产出 planner_package → `unitId` 来自 LLM → 所有 artifact refs 写入并通过 schema 校验 |
| `throws PlannerPipelineError when LLM role fails` | mock scenario = `failure` → `AGENTFLOW_PLANNER_ROLE_FAILED` |
| `throws when planner package references are inconsistent` | mock/fake adapter 产出 schema 合法但 `batch.unit_refs` 或 `contract.unit_ref` 与 `units[0].ref` 不一致 → `AGENTFLOW_PLANNER_PACKAGE_INCONSISTENT` |
| `throws when provider is unavailable` | config 中不配置 planner.initial → `provider_unavailable` |
| `passes planner package schema path to adapter` | fake adapter 或 request 捕获断言 `metadata.outputSchemaPath === 'schemas/llm/llm.planner_package.schema.json'`，防止误用默认 role_output schema |

测试 setup 复用 `preparePlannedRun()` 模式（参考 `tests/evaluator/evaluator-pipeline.test.ts:87-140`）：创建临时 git repo → 写 TASK.md + config → `ContextBuilder.build()` → `PlannerPipeline.build()`。

注意：`units[0].ref` 缺失本身会被 `registry.assertLlmPayload('planner_package', payload)` 先拦截为 `SchemaValidationError`，不适合作为 `AGENTFLOW_PLANNER_UNIT_REF_MISSING` 的专属测试。

### Step 5：更新 `tests/cli/run-e2e.test.ts`

当前 fixture wrapper（`writeFailFixPassWrapper()`，line 193-249）只处理 `generator.implementer` 角色。改造后需要：

1. 在 wrapper 中检测 `role === 'planner.initial'` 时，向 output artifact 文件写入合法的 `planner_package` JSON
2. 保持 `unitId` 为 `'auth-refresh'`（与现有路径断言 `.agentflow/units/auth-refresh/...` 一致）
3. 非规划器角色的逻辑保持不变
4. 更新 `cli_processes_started` 预期：Planner 也会启动一次 provider，因此 fail → fix → pass 路径应从 `4` 调整为 `5`（planner initial + generator initial + evaluator initial + generator fix + evaluator retry）

同时在 `.agentflow/settings.json` fixture 中新增 `planner.initial`：

```json
"planner.initial": {
  "provider_candidates": [
    { "provider": "fixture-wrapper", "model": "fixture-wrapper" }
  ]
}
```

---

## 移除的死代码

| 位置 | 内容 | 原因 |
|------|------|------|
| `planner-pipeline.ts:481-563` | `buildPlannerPackagePayload()` | 被 LLM 调用取代 |
| `planner-pipeline.ts:380-412` | `selectVerificationCommand()` | 只被已移除的桩函数使用 |
| `planner-pipeline.ts:115-118` | `verificationCommand` 变量 | 死代码 |

---

## 验证

```bash
# 1. 类型检查
npm run typecheck

# 2. Planner 单元测试
npx vitest run tests/planner/planner-pipeline.test.ts

# 3. 下游 pipeline 测试（验证 unitId 动态提取不破坏下游）
npx vitest run tests/generator/generator-pipeline.test.ts
npx vitest run tests/evaluator/evaluator-pipeline.test.ts

# 4. CLI E2E 测试
npx vitest run tests/cli/run-e2e.test.ts

# 5. 默认配置/Provider 选择回归
npx vitest run tests/config/config-loader.test.ts
npx vitest run tests/adapters/adapter-command.test.ts

# 6. 全量回归
npm test
```

通过标准：
- 所有测试通过
- Planner 的 `unitId` 不再是硬编码 `'auth-refresh'`，而是从 LLM 产出提取
- mock provider 在 `planner.initial` 角色下产出合法的 `planner_package`
- 下游 Generator/Evaluator 无需代码改动，通过 `options.planner.unitId` 自动拿到动态值
- Planner 调用 wrapper 时使用 `llm.planner_package.schema.json`，不是默认 `llm.role_output.schema.json`
- 默认配置包含 `planner.initial`，无项目配置时仍能选择默认 codex provider
- planner package 的 unit/batch/contract 引用一致性被语义校验覆盖
