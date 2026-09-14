# MyGateway 测试指南

本文是人类和 Agent 维护测试的规范入口，统一定义测试分层、固定脚本、用例归属和不同开发活动
的质量门禁。测试代码是具体行为的权威来源；本文不记录某次运行的用例数量或生产部署结果，
避免过程快照随代码演进失真。

## 1. 测试方法论

采用由快到慢、由确定到外部依赖的分层测试。业务规则优先放在最低且足以证明行为的层级；API
可以验证的输入组合不在 UI 重复穷举，浏览器测试聚焦关键用户旅程。真实外部系统与确定性 CI
分开，避免网络、费用和供应商波动掩盖产品回归。

### 1.1 分层、脚本与用例归属

| 层级 | 性质 | 测试内容 | 固定脚本 | 主要用例 |
|---|---|---|---|---|
| L0 静态门禁 | 静态 | 文档链接、机器路径、类型、Dashboard 构建、部署配置 | `npm run test:fast` 的静态部分 | `scripts/check-docs.mjs`、`scripts/check-deploy-config.mjs`、TypeScript、Vite |
| L1 单元与存储语义 | 白盒 | 纯函数、Blob 读写与索引语义、种子、协议、缓存、配额、Token、错误边界 | `npm run test:unit` | `test/*.test.ts`（内存 `FakeKV` 替身） |
| L2 API / 服务测试 | 灰盒 | 真实边缘函数 HTTP、Admin/Management 契约、Blob 结果、权限与凭据脱敏 | `npm run test:api` | `e2e/admin-api.spec.ts`、`e2e/management-api.spec.ts` |
| L3 UI 功能测试 | 黑盒 | 登录、导航、表单、Dialog、刷新恢复、关键响应式与确定性布局 | `npm run test:ui` | `e2e/journey.spec.ts`、`e2e/management-ui.spec.ts` |
| L4 可控系统集成 | 黑盒 | 本地假 Provider、路由、Fallback、SSE、超时、流中断和取消传播 | `npm run test:system` | `e2e/controlled-upstream.spec.ts` |
| L5 SIT 真实集成 | 外部黑盒 | 真实 Provider、真实 Token/usage、余额、SDK 与部署环境集成 | `npm run test:sit` | 当前 `e2e/real-provider.spec.ts`，未来按 Provider/领域拆分 |
| L6 Agent 视觉审查 | 探索性 | 层级、留白、密度、暗色和整体审美 | 暂不提供，不作为门禁 | 未来由固定截图场景和多模态审查组成 |

L2 通过公开 HTTP 契约观察结果，但会使用部署实例自身的 Blob 存储准备和核对状态，因此称为灰盒；
不要把所有 API 测试称为白盒。L3 只断言用户可观察的行为，少量尺寸、重叠和视口断言用于防止确定性布局
回归，不承担主观审美判断。

### 1.2 固定命令

| 命令 | 用途 | 前置条件 |
|---|---|---|
| `npm run test:fast` | L0 + L1：文档、类型、单元测试和生产构建 | 无外部服务 |
| `npm run test:deploy-config` | 检查 `edgeone.json` 构建配置正确，且不再依赖 Cloudflare/Wrangler，Secret 只存在于项目环境变量 | 无外部服务 |
| `npm run test:api` | L2 API / 服务测试 | 已部署的测试实例（`E2E_BASE_URL`） |
| `npm run test:ui` | L3 UI 功能测试 | 已部署的测试实例，Chromium 已安装 |
| `npm run test:system` | L4 可控系统集成 | 已部署的测试实例 |
| `npm run test:sit` | L5 真实集成，显式开启 `RUN_SIT=1` | 已部署的测试实例、专用且限额的 Provider Key |
| `npm run test:release:local` | L0–L4 的确定性发布门禁 | 已部署的测试实例 |
| `npm run test:release` | L0–L5 完整版本发布门禁 | 已部署的测试实例与 SIT 凭据 |
| `npm run test:smoke -- <URL>` | 部署后只读健康检查 | 已部署的网站地址；默认检查本地 8799 |

这些名称是长期入口。新增行为应扩充对应现有用例；只有出现新的测试边界或外部系统时才新增套件，
并同步更新固定脚本。不要在文档、CI 或聊天中拼接一次性测试命令替代这些入口。

### 1.3 不同活动的测试门禁

| 活动 | 必须执行 | 按影响追加 |
|---|---|---|
| 开发中的局部反馈 | 对应单元文件或单个 Playwright 用例 | 仅用于快速定位，不代表完成 |
| 完成一个小功能或 Bug | `npm run test:fast` | API 改动加 `test:api`；UI 加 `test:ui`；路由/流式加 `test:system` |
| 文档或部署说明 | `npm run docs:check` + `git diff --check` | 命令变化时运行对应脚本的收集或 smoke |
| Pull Request | `npm run test:fast` + 所有受影响层 | Blob 对象路径变化时用真实部署实例验证读写与分页 |
| 发布小版本 | `npm run test:release` | 任何层失败都停止发布；不得用重跑掩盖不稳定用例 |
| 部署完成 | `npm run test:smoke -- https://部署域名` | 只有明确授权时才执行会计费的最小模型调用 |

Bug 修复必须在最低有效层增加回归用例。跨层缺陷可以增加一条高层旅程，但不复制所有低层输入
组合。Provider、协议、Token/usage 或 SDK 行为变化必须运行 SIT；纯 UI 文案变化无需消费真实 Token。

### 1.4 用例设计与维护

- 测试名描述稳定的产品行为，不使用 `repro`、工单号、Agent 名或一次性故障名称。
- 使用 Arrange / Act / Assert 组织用例；一个用例聚焦一个行为或一组不可拆分的业务闭环。
- 优先使用确定性数据和可控时间；禁止依赖测试执行顺序，确需串行旅程时必须在文件内明确说明。
- UI 使用 `getByRole`、`getByLabel` 等用户可见契约；只有布局回归才读取尺寸或样式。
- API 用例同时断言 HTTP 状态、稳定错误码和最终资源状态；凭据操作必须断言敏感字段不泄漏。
- 外部测试必须显式开启并使用专用限额凭据；缺少 SIT 凭据时发布门禁应失败，不能假通过。
- 不用 retry 把 Flaky 测试变绿。先保留 Trace、定位共享状态或等待条件，再修正用例。
- 删除产品能力时同步删除或改写对应测试；测试不是只增不减的历史档案。

## 2. 单元测试

单元测试按领域拆分如下；准确用例数以 `npm test` 输出为准：

| 文件 | 覆盖重点 |
|---|---|
| `access-resolver.test.ts` | Key 与模型冷请求 Blob 查询次数、缓存状态 |
| `provider-balance-cache.test.ts` | 强制刷新、五分钟缓存、失效竞态和概览回读 |
| `deepseek-balance.test.ts` | 官方 host、金额精度、鉴权和错误清理 |
| `key-quota.test.ts` | 密钥到期、RPM 窗口、日 / 周 / 月 / 年预算边界、台账缓存与成本计算 |
| `log-policy.test.ts` | 日志总开关、级别策略、Blob 写入组合、TTFT 与上下文写入矩阵 |
| `runtime-settings.test.ts` | 请求体默认值、16-64 MiB 校验、isolate 缓存及声明/流式大小边界 |
| `fallback-policy.test.ts` | HTTP / Provider 错误分类 |
| `model-discovery.test.ts` | OpenAI / Gemini / Anthropic 模型列表、分页和 ID 规范化 |
| `passive-circuit-breaker.test.ts` | 阈值、冷却、恢复和容量 |
| `password.test.ts` | 密码规则、摘要和验证 |
| `protocol-conversion.test.ts` | Chat / Messages 请求与非流式响应 |
| `protocol-routing.test.ts` | 原生优先、转换候选和协议不匹配 |
| `protocol-stream.test.ts` | Chat / Messages SSE 转换 |
| `provider-localization.test.ts` | 中英文预置名、历史默认名兼容和自定义渠道名保留 |
| `provider-presets.test.ts` | 预制唯一性、端点和协议能力 |
| `provider-balance-ui.test.ts` | 跨 isolate `not_queried` 不覆盖浏览器刷新结果 |
| `server-timing.test.ts` | 稳定计时响应头 |
| `sse-decoder.test.ts` | 任意分片、UTF-8、多事件和 usage |
| `ttl-lru.test.ts` | TTL、LRU 和容量淘汰 |
| `usage.test.ts` | 时区、统计范围、Token 校验和终态幂等 |
| `analytics.test.ts` | 5 分钟桶、上下文 AES-GCM 与 4 KiB 截断、三协议 SSE 有效内容检测 |

运行：

```bash
npm test
npm run typecheck
```

单元测试不得依赖真实 Provider、生产 Blob 存储或任何云账号。数据层用例通过
`test/helpers/fake-kv.ts` 提供的内存 `FakeKV` 替身注入，并可直接断言读、写、删除和
`list` 调用次数。

## 3. E2E 环境

E2E 需要一台已部署的 MyGateway 实例（推荐 EdgeOne Makers 预览部署），并将 `E2E_BASE_URL`
指向它。默认值为 `http://localhost:8799`，便于使用本地端口转发或自定义域名映射。

安装浏览器：

```bash
npx playwright install chromium
```

准备 `.env`：

```text
INITIAL_ADMIN_PASSWORD=<部署实例的首次密码>
MASTER_KEY=<32 字节随机值的 base64，本地开发用>
DEEPSEEK_TEST_KEY=<可选，真实集成使用>
```

运行：

```bash
npm run test:e2e
```

如果使用其他地址：

```bash
E2E_BASE_URL=https://your-preview.edgeone.app npm run test:e2e
```

E2E 会创建、修改和删除渠道、模型与 Gateway Key。不要指向包含需要保留数据的 Blob 存储；
开发时推荐为测试单独绑定一个 Blob 存储或使用独立的预览部署。

## 4. UI 旅程

`e2e/journey.spec.ts` 串行覆盖以下管理闭环：

1. 未登录访问跳转登录页；
2. 错误管理员凭据显示错误；
3. 正确登录，并验证侧边栏收缩、暗黑模式和主题持久化；
4. 通过预制弹窗添加 DeepSeek 渠道，验证三协议 path/Base URL 编辑器、保存前必须预检、失败
   降级保存、完成动效、自动余额查询、手工库存、勾选导入、批量摘要和竖向渠道卡片；并通过
   Admin API 验证相同供应商 + Provider Key 再次创建返回 `409 resource_in_use` 且不会重复导入；
5. 通过模态表单创建统一模型和渠道实例，并验证同一模型重复绑定相同渠道返回 409；
6. 创建带到期时间和年度请求 / Token 预算的 Gateway Key，验证周期表单、明文只展示一次，并拒绝
   创建已过期密钥；单元测试覆盖日 / 周 / 月 / 年 UTC 边界、周期范围汇总与缓存窗口内单次 Blob 汇总；
7. 调用 `/v1/models` 和 Chat 接口，验证认证、错误和 timing Header；
8. 无 Gateway Key 返回 401；
9. Dashboard 显示渠道、首个已创建模型和 Provider Balance；创建服务端标记的 1 小时临时
   密钥，验证固定到期时间、不可续期 / 重新生成、刷新后从 `localStorage` 恢复，并在本地到期
   后自动清除；单元测试同时约束列表隐藏与创建 / 删除时的惰性清理；
10. 删除渠道显示关联影响，清理失去最后实例的统一模型，并保留仍有备用渠道的模型；
11. Analytics Usage 页面展示指标卡、模型表和筛选切换；
12. Analytics Logs 页面展示日志表、游标分页和详情抽屉；日志策略与清空日志仅在系统设置页；
13. System 运行参数展示 16 MiB 默认值，可保存至最高 64 MiB，并验证参数卡片顺序；
14. 退出登录回到登录页。

该套件不需要有效 Provider Key，但 Chat 错误透传用例会用 dummy key 请求 DeepSeek 并期待
401，因此运行环境需要能够访问其 API。

## 5. Admin API 与调用边界

`e2e/admin-api.spec.ts` 不使用真实 Provider Key，按以下领域串行组织：

1. 读取和保存 Gateway 请求体上限，拒绝低于 16 MiB 或高于 64 MiB 的值；
2. 创建自定义三协议渠道，验证空协议、重复协议、非 HTTPS 地址、重复 Provider Key；保存名称、
   协议 Base URL 和启停状态，并验证编辑阶段的重复 Key 冲突；
3. 手工渠道模型库存的添加、重复添加幂等、列表、删除与非法参数；
4. 统一模型创建、重复 ID、渠道实例添加、同渠道重复实例、Alias 冲突、实例定价、币种校验、
   负价格、回退顺序、模型编辑、删除后使用相同 ID 重建；
5. 从库存导入模型、重复导入幂等、库存缺失和超过 100 个模型的批量限制；
6. Gateway HTTP 验证模型白名单、停用 Key、未知模型、协议不可用及渠道停用后的模型不可用。

该套件只使用部署实例自身的 Blob 存储和不会实际访问的 Provider 地址，适合常规 CI。它不替代下述可控上游与
真实 Provider 测试。

## 6. Management API 与 Skill

`e2e/management-api.spec.ts` 使用真实边缘函数 HTTP 和部署实例的 Blob 存储，覆盖 Skill 中声明的只读查询与
资源写操作、公开能力发现与双规范 API 文档、无凭据拒绝、`read` / `write` 权限、渠道与模型实例创建、Gateway Key
一次性明文、余额/用量/日志查询，以及
Management Key 的到期、停用和删除。测试显式断言 Provider Key、hash 和 ciphertext 不会
出现在响应中。

同一旅程还覆盖 Overview 初始化状态机：空网关为 `needs_channel`，仅有渠道为 `needs_model`，形成
活动模型链路后为 `needs_gateway_key`，创建客户端 Key 后为 `ready`；每一步都断言 Overview 不包含
Provider Key 或一次性 Gateway Key。Skill 静态断言覆盖首次体检、资源用途、渠道/价格边界和空网关
引导语义，并覆盖渠道/库存/统一模型关系、自动发现操作边界、非文本产品不受数据面支持、最小 API
选择、`active` 非健康结论、Provider Presets 复用，以及 manifest 的 `SKILL.md` / `download_url`
更新约定。Provider 单元测试覆盖官方 Host 的唯一身份识别和未知 Host 保持自定义。

`e2e/management-ui.spec.ts` 验证 System 页自动检测网站访问地址、拒绝非 Origin 输入，并将保存后
的规范地址同步到首页端点与 Agent 提示词；提示词只包含 Skill 安装入口，manifest 版本检查规则
由托管 `skill.md` 提供。同时验证默认展示安全占位符，创建后配置提示词包含一次性 Key，刷新仍可
从同源 `localStorage` 恢复，并在 1 小时窗口失效或删除后恢复占位模板。
API E2E 同时确认 `/skills/index.json`、`/skill.md` 和 `/skill.json` 可由部署网站直接读取，断言
入口文件不依赖本地 helper，并检查 Skill 明确要求安全持久化与后续加载 Management Key。公开文档
测试还验证 `/v1/api-docs` 包含两份规范、`/management/v1/api-docs` 无需鉴权，以及 OpenAPI 的
写入凭据标记、查询参数和权限声明。Skill 可做无凭据发现 smoke test：

```bash
curl http://localhost:8799/skill.md
curl http://localhost:8799/management/v1/capabilities
curl http://localhost:8799/management/v1/api-docs
curl -H "Authorization: Bearer $MYGATEWAY_MANAGEMENT_KEY" \
  http://localhost:8799/management/v1/overview
```

Skill 的结构、manifest 和托管文件由 Management API E2E 校验。某个 Agent 平台提供的 Skill
校验器可以作为额外检查，但不能把个人机器上的工具路径写成项目标准命令。

## 7. 可控上游集成

`e2e/controlled-upstream.spec.ts` 会由 Playwright 进程在随机 loopback 端口启动本地假 Provider，
不读取或发送真实 Provider Key。请求仍经过正在运行的边缘函数、Blob 路由和真实 HTTP fetch，当前覆盖：

1. 上游 `503`、`429` 和连接断开后按优先级切换到备用渠道；
2. 上游 `401` 属于不可重试错误，不错误切换渠道；
3. Provider 鉴权头使用解密后的渠道 Key，请求模型被替换为渠道模型 ID；
4. 响应已提交后流式上游中断，不跨渠道续接内容；
5. 客户端取消流式响应时，取消传播至当前上游连接；
6. 上游响应头超时后切换备用渠道（使用短超时测试模式）。

常规运行会执行除超时外的用例：

```bash
npm run test:e2e:upstream
```

超时用例需要部署实例与测试使用相同的短超时值。在预览部署的环境变量中临时设置
`UPSTREAM_HEADER_TIMEOUT_MS=300`，然后运行：

```bash
E2E_UPSTREAM_TIMEOUT_MS=300 npm run test:e2e:upstream
```

这里的短超时只用于测试，不应照搬到生产配置。假 Provider 对慢请求最长等待 5 秒，避免使用默认
30 秒超时拖慢常规测试。

## 8. SIT 真实集成

SIT 是真实外部集成阶段，DeepSeek 只是当前第一个测试对象。`npm run test:sit` 会显式设置
`RUN_SIT=1`；缺少 `DEEPSEEK_TEST_KEY` 时直接失败，避免发布门禁把“没有运行”误报为成功。
当前 `e2e/real-provider.spec.ts` 串行覆盖：

1. 在页面用真实 Key 预检 V4 模型，确认预检不创建渠道，取消一个模型后只导入勾选项；
2. 渠道连接测试；
3. 查询官方账户余额并校验金额字符串；
4. 通过官方模型列表发现 V4 模型，并导入为可调用的网关模型；
5. 创建 Gateway Key；
6. 非流式 Chat completion 和 usage；
7. 流式 Chat、`[DONE]` 和 usage chunk；
8. DeepSeek 原生 Messages 非流式请求；
9. DeepSeek 原生 Messages 流式事件；
10. 管理端用量汇总。

这些测试会产生少量真实模型调用和 Provider 费用。Key 只能从环境读取，不得硬编码、写入
日志或测试报告。

单独运行：

```bash
npm run test:sit
```

未来真实 Token 消费、Provider usage 与网关 Analytics/每日限额的一致性、OpenAI/Anthropic SDK、
更多供应商和远程 EdgeOne Makers 环境都归入 SIT。余额扣减可能异步、受套餐或赠金影响，只作为辅助
观测；准确断言应基于 Provider 响应 usage、网关聚合和请求日志之间的一致性。

SIT 使用专用测试账号、限额 Key、低成本模型和短输出，不得读取个人或生产凭据。测试结束清理
创建的渠道、模型和密钥，并记录实际请求数；Provider 网络故障应与产品断言失败明确区分。

## 9. SSE Fixture 要求

协议或流式逻辑变化时至少覆盖：

- 一个 SSE event 跨多个网络 chunk；
- 一个 chunk 包含多个 event；
- 中文 UTF-8 跨 chunk；
- 多行 `data:`；
- 正常 usage 和 `[DONE]`；
- usage 缺失、JSON 损坏和上游中断；
- 客户端取消；
- finalizer 最多写入一次；
- 工具参数跨多个增量事件。

## 10. 发布前检查

```bash
npm run test:release
git diff --check
```

贡献者没有 SIT 凭据时可以运行 `npm run test:release:local` 验证全部确定性层；正式发布维护者必须
继续运行 `npm run test:sit`，不能把缺少真实凭据解释为完整发布验证。

还应确认：

- 在不预先创建 `.env` 的干净源码副本中，`npm run test:fast` 能完成文档检查、类型检查、单元测试和
  Dashboard 构建，且不向终端输出 `MASTER_KEY` 明文；
- `npm run test:deploy-config` 确认 `.env.example` 只含带默认值的初始管理员密码、`edgeone.json`
  的安装/构建/输出配置正确且不含 Secret、仓库不再保留 `wrangler.jsonc` 或任何 Cloudflare 依赖；
- 单元测试覆盖 `seedDefaults` 的幂等性：全新 Blob 存储得到 6 条设置和 30 条价格基线，重复执行
  不产生额外写入，且不覆盖管理员已修改的值；
- Dashboard 生产资源可加载；
- 日志、trace 和失败报告不含 Key、Prompt 或 Response；
- 生产 smoke test 只读取健康页和公开资源，除非明确授权使用生产凭据。

## 11. 尚未自动化的验证

- 1KB、100KB、1MB 非流式响应的 CPU 基线；
- 长 SSE 和慢客户端压力测试；
- 1、2、3 候选 Fallback 的 P95/P99；
- Blob 读放大、写放大与 `list` 分页成本基线；
- 接近项目 CPU 配额时的持续负载。

这些结果建立后应更新 [部署指南容量规划](DEPLOY.md#7-容量规划) 中的建议
使用范围，而不是把估算写成已验证事实。
