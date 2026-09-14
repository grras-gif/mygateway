# MyGateway 部署指南

[English](DEPLOY.en.md) · [简体中文](DEPLOY.md)

本文只说明部署、升级、回滚和排障。产品介绍见 [README](../README.md)，
系统结构见[架构文档](ARCHITECTURE.md)，验证方法见[测试指南](TESTING.md)。

目标是让用户以尽量少的步骤把 MyGateway 部署到自己的 EdgeOne Makers 项目，并通过
Git 集成持续更新。

## 1. 部署方式总览

| 方式 | 是否推荐 | 说明 |
|---|---|---|
| EdgeOne Makers 控制台导入 Git 仓库 | ✅ 推荐 | 浏览器完成，零本地操作 |
| 控制台手动上传/本地构建产物 | ✅ 可选 | 需要本地 `npm run build:dashboard` |
| 自动部署（Git 集成） | ✅ 推荐 | push 即自动重新部署 |

## 2. 机制要点

### 2.1 EdgeOne Makers 项目做了什么

EdgeOne Makers 读取仓库根目录的 `edgeone.json`：

1. `installCommand`：`npm install`
2. `buildCommand`：`npm run build:dashboard`
3. `outputDirectory`：`dashboard/dist`，作为静态资源目录发布
4. 仓库内的 `functions/**` 自动注册为边缘函数；`functions/[[default]].ts` 是 catch-all 入口
5. 其余环境变量（`MASTER_KEY`、`INITIAL_ADMIN_PASSWORD`）在控制台的项目环境变量中配置，不进入仓库

项目通过官方 SDK `@edgeone/pages-blob` 以命名空间方式访问 Blob 存储（命名空间首次调用
自动创建），无需在控制台绑定环境变量。MyGateway 的所有持久化配置、用量聚合和可选请求日志
都保存在该命名空间内。

### 2.2 关键设计

- `edgeone.json` 只保留构建/输出配置，不包含任何 Secret；密钥全部通过控制台环境变量注入
- `functions/[[default]].ts` 只接管 `/health`、`/v1/*`、`/admin/api/*`、`/management/v1/*`；
  其他路径通过 `context.next()` 回落到 `dashboard/dist` 静态资源，控制台路由不受影响
- Blob 存储没有 schema，因此不再有 SQL migration 步骤。基础设置和模型价格由
  `src/db/bootstrap.ts` 在首次访问后端接口时幂等写入（已存在的键不会被覆盖）
- 首次部署时边缘函数入口通过 `context.waitUntil()` 触发一次 seed，不阻塞首个请求；
  seed 失败只记录 `kv_seed_failed` 事件，不影响已返回的响应
- `MASTER_KEY` 用于加密 Provider Key 和可选的敏感日志上下文；生成后不要删除或轮换，
  否则已有加密数据将无法读取
- 管理员初始密码默认 `mygateway123`，首次登录后必须修改；修改后 `INITIAL_ADMIN_PASSWORD`
  不再参与正常登录
- 渠道被动熔断只使用 isolate 内存（3 次故障、冷却 30 秒），不新增外部服务
- 周期性清理不再依赖 Cron：管理接口 `POST /admin/api/system/cleanup` 可按需触发过期
  统计、请求日志、上下文和密钥日台账的清理

使用初始账号登录后，控制台会强制进入凭据修改页。生产排障时优先在响应的
`X-Gateway-Timing` 查看缓存命中、Blob 查询、上游首包和网关首包耗时；标准 `Server-Timing`
也会写入。平台日志只保留抽样的脱敏结构化事件，不应依赖它做精确请求计数。

## 3. 自动部署（Git 集成）

在 EdgeOne Makers 控制台将项目连接到 Git 仓库后，push 到生产分支自动触发构建与部署：

```
push 代码 → Git 仓库 → EdgeOne Makers 构建
  → npm install → 构建控制台（dashboard/dist）
  → 发布静态资源 + functions/** 边缘函数
  → 生产更新
```

**项目配置**：

| 字段 | 值 |
|---|---|
| 代码来源 | 你 Fork 后的真实仓库；使用上游仓库时为 `Leon00x/mygateway` |
| 生产分支 | `main` |
| 安装命令 | `npm install` |
| 构建命令 | `npm run build:dashboard` |
| 输出目录 | `dashboard/dist` |
| 存储 | 通过官方 SDK `@edgeone/pages-blob` 命名空间访问（首次调用自动创建），无需环境绑定 |
| 环境变量 | `MASTER_KEY`、`INITIAL_ADMIN_PASSWORD` |

> 这些值以仓库根目录的 `edgeone.json` 为权威来源；控制台中的同名字段应与其保持一致，
> 避免构建产物与边缘函数版本不一致。

## 4. 升级与回滚

### 4.1 日常升级

合并或推送到生产分支 `main` 后，EdgeOne Makers 会依次构建控制台、发布静态资源与边缘函数：

```text
main 更新 → 构建 → 静态资源 + 边缘函数 → 生产更新
```

- Blob 存储没有 schema 迁移，新版本必须能直接读取旧数据；新增字段请保持向后兼容的读取默认值
- 普通升级不会重置管理员密码，也不会轮换 `MASTER_KEY` 或 Provider Key
- `MASTER_KEY` 保存在项目环境变量中，日常升级无需读取或重新设置；不要删除或轮换
- 生产变更完成后按[测试指南](TESTING.md)执行最小发布检查

### 4.2 回滚边界

EdgeOne Makers 支持回滚到历史部署版本，静态资源与边缘函数会一起回退。Blob 存储中的数据不会
随部署回滚，因此数据变更应优先采用新增字段、兼容读取和分阶段切换；需要回退数据时，
应编写修复逻辑处理，而不是直接删除生产数据。

## 5. 常见问题

1. **代码来源选错**：把项目名当成仓库名 → 连到不存在的仓库，构建永不触发。**仓库名必须与 Git 上真实一致**。
2. **构建命令错误**：只跑 `npm run build:dashboard` 才能产出 `dashboard/dist`；不要改成依赖 Cloudflare/Wrangler 的旧命令。
3. **Blob 访问失败**：`@edgeone/pages-blob` 未能在运行时初始化时，所有后端接口都会因缺少数据存储而失败；确认已部署到 EdgeOne Makers 运行时。
4. **重复生成 MASTER_KEY**：项目环境变量中的 `MASTER_KEY` 一旦写入就不应再改；不要手工删除或覆盖生产值。
5. **把 Secret 提交进仓库**：`MASTER_KEY`、`INITIAL_ADMIN_PASSWORD` 只能存在于项目环境变量和本地 `.env`；`.env` 已在 `.gitignore` 中忽略。
6. **误以为需要 migration**：Blob 存储无 schema，无需执行任何 SQL；若控制台看不到基础设置/价格，检查 Blob 命名空间访问与 seed 日志事件。

## 6. 诊断命令

```bash
# 本地类型检查与快速门禁
npm run typecheck
npm run test:fast

# 校验部署配置（edgeone.json / 入口文件 / 无 Cloudflare 残留）
npm run test:deploy-config

# 手动构建控制台产物
npm run build:dashboard

# 触发一次过期数据清理（需管理员会话或管理密钥）
curl -X POST https://your-project.edgeone.app/admin/api/system/cleanup
```

部署后至少确认：项目构建成功、管理控制台可打开、Blob 命名空间可访问，并对健康页或一个已配置的
模型完成 smoke test。不要在日志或工单中粘贴 `MASTER_KEY`、Gateway Key、Provider Key、
Prompt 或完整响应。

## 7. 容量规划

默认部署只使用：

```text
1 个 EdgeOne Makers 项目（静态资源 + 边缘函数）
1 个 Blob 存储
2 个首次部署环境变量（MASTER_KEY、INITIAL_ADMIN_PASSWORD）
0 个定时任务
```

与本项目最相关的限制（额度可能变化，部署前应查看
[EdgeOne Makers 文档](https://edgeone.ai/document/177158575068948480)）：

| 项目 | 说明 | MyGateway 的控制方式 |
|---|---|---|
| 边缘函数请求 | 按项目配额计费 | 管理请求、模型调用和静态资源请求都可能计入，应以项目指标为准 |
| 边缘函数 CPU 时间 | 按项目配额计费 | 流式转发、有限解析，不缓存完整响应 |
| 外部子请求 | 每次调用受限 | 最多尝试 3 个 Provider，候选串行而非广播 |
| Blob 读取 | 按存储配额计费 | 索引对象让鉴权与路由保持单次 `get`；短 TTL isolate 缓存降低读放大 |
| Blob 写入 | 按存储配额计费 | 每个完成请求写入 Analytics、密钥用量和可选日志 |
| Blob 存储 | 按存储配额计费 | 分钟聚合 30 天、请求日志 1–7 天（控制台可调）、密钥用量 30 天 |
| 日志 | 平台采样保留 | 抽样与脱敏事件 |

降低额度的关键做法：

- 热请求使用有容量上限的 isolate 内存缓存，缓存命中时不访问 Blob；冷请求通过少量 `get`
  完成鉴权与路由，唯一性索引（`gateway_key_hash/*`、`management_key_hash/*`、
  `admin_user_name/*`）保证不会退化为全量扫描；
- 用量、密钥用量和请求日志在同一 `waitUntil()` 内提交，失败不阻断模型响应；
- 密钥未配置周期预算时跳过配额 Blob 读取；有限额 Key 每 isolate 默认最多 30 秒执行一次范围汇总；
- 过期统计的清理改为按需触发（`POST /admin/api/system/cleanup`），不再依赖每日 Cron；
  预算日台账至少保留 370 天；
- 熔断和 RPM 窗口保存在 isolate 内存，不产生额外 Blob 写入。

边界与超额行为：Blob 达到配额后配置路由可能返回 503；usage 写入或看板查询失败不会中断
已完成的模型响应；边缘函数达到项目配额后由平台拒绝请求。如果代表性负载持续接近额度，
应降低统计/日志开销或提升项目规格，不能静默牺牲安全校验和流式正确性。
