<div align="center">

# MyGateway

**A simple multi-provider AI gateway you can manage with your preferred AI agent.**

Connect multiple AI providers behind one API, one key system, and one management console—without running a dedicated server.

[English](README.md) · [简体中文](README.zh-CN.md)

[![Deploy to EdgeOne Makers](https://img.shields.io/badge/Deploy-EdgeOne%20Makers-0052D9)](https://console.cloud.tencent.com/edgeone/makers)

[![CI](https://github.com/Leon00x/mygateway/actions/workflows/ci.yml/badge.svg)](https://github.com/Leon00x/mygateway/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![EdgeOne Makers](https://img.shields.io/badge/EdgeOne-Makers-0052D9?logo=tencentcloud&logoColor=white)](https://edgeone.ai/products/makers)

</div>

> MyGateway is currently a `0.1.x` public alpha. It is designed for personal projects and small teams that want a compact, transparent gateway. For a broad enterprise platform with hundreds of providers and advanced tenancy, consider a mature project such as [LiteLLM](https://github.com/BerriAI/litellm).

## Why MyGateway

1. **One-click deployment to EdgeOne Makers** — no server to maintain. Static console assets and the edge function share one EdgeOne Makers project, and the default architecture fits the platform's free quota for everyday use by individuals and small teams.
2. **Multiple providers behind one model** — place equivalent models from different providers behind one public model name. Order channels by price or your own preference, and automatically fail over when the preferred channel is unavailable.
3. **Manage it with your preferred AI agent** — the official Skill lets agents such as Codex, Claude Code, and Pi inspect your gateway, add providers and models, manage client keys, and check balances, usage, and logs.

MyGateway also supports OpenAI Chat, OpenAI Responses, and Anthropic Messages APIs, with usage limits, cost analytics, request logs, and a bilingual console.

```text
Apps / SDKs
    │  Chat Completions · Responses · Messages
    ▼
MyGateway Edge Function ── authentication & limits ── routing & fallback ── AI providers
    │
    ├── SolidJS management console (static assets)
    └── KV: configuration, usage aggregates, optional request logs
```

## Features

| Module | Core capabilities |
|---|---|
| **Gateway** | OpenAI Chat, OpenAI Responses, Anthropic Messages, and model discovery endpoints |
| **Providers** | Provider presets, custom endpoints, connection checks, model discovery, and encrypted credentials |
| **Models & routing** | Multiple channels per model, price- or preference-based ordering, and automatic failover |
| **API keys** | Expiration, model access, RPM, and request/Token budgets by day, week, month, or year |
| **Analytics** | Request and Token trends, latency, time to first token, success rate, estimated cost, and request logs |
| **Console** | Bilingual interface, light/dark themes, channel and model management, pricing, keys, logs, and settings |
| **Agent management** | Use the official Skill with familiar AI agents to manage providers, models, and keys or inspect balances, usage, and logs |
| **Security** | Encrypted provider credentials, hashed client keys, protected admin sessions, and opt-in encrypted context previews |

The complete implementation status and roadmap are maintained in the [PRD](docs/PRD.md).

## Deploy

Create an EdgeOne Makers project from this repository. The project installs dependencies with `npm install`, builds the console with `npm run build:dashboard`, and serves `dashboard/dist` as static assets; `functions/[[default]].ts` handles `/health`, `/v1/*`, `/admin/api/*`, and `/management/v1/*`. Every other path falls through to the console. See [`edgeone.json`](edgeone.json) for the exact build settings.

Then bind a KV namespace named `DB` and add the runtime environment variables (`MASTER_KEY`, `INITIAL_ADMIN_PASSWORD`) in **Project → Environment Variables**. `MASTER_KEY` is generated once by the platform or supplied by you; it must not be changed or rotated after provider credentials are stored.

Initial administrator credentials:

```text
Username: admin
Password: mygateway123
```

You must change them after the first sign-in. Baseline settings and model prices are seeded into KV on the first backend request, so no migration step is required.

See the [deployment guide](docs/DEPLOY.en.md) for upgrades, rollback, troubleshooting, and quota planning.

## Run locally

Requires Node.js 22 or later.

```bash
git clone https://github.com/Leon00x/mygateway.git
cd mygateway
npm install
cp .env.example .env
npm run dev
```

`npm run dev` starts the console dev server at <http://localhost:5173>. The gateway backend runs on the edge function runtime, so the fastest way to exercise `/v1/*`, `/admin/api/*`, and `/management/v1/*` end to end is a preview deployment of your EdgeOne Makers project. The KV namespace bound as `DB` is seeded automatically on the first backend request.

For the manual development loop and test commands, see the [contributing guide](docs/CONTRIBUTING.md). Before submitting a change, run:

```bash
npm run typecheck
npm test
npm run build
```

## API example

```bash
curl https://your-project.edgeone.app/v1/chat/completions \
  -H "Authorization: Bearer YOUR_GATEWAY_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"your-model","messages":[{"role":"user","content":"Hello"}]}'
```

Anthropic clients can point their base URL to the same deployment and send the Gateway Key through `x-api-key` to `/v1/messages`. Responses requests use a provider's native Responses endpoint.

## Agent management

MyGateway includes an official Skill for agents such as Codex, Claude Code, and Pi. An agent can inspect the current setup, add or remove providers and models, manage client keys, and check balances, usage, logs, and service health. It asks for confirmation before important operations.

Create an agent credential under **System → Management Keys & Skill**, then give the one-line installation prompt shown there to your agent. This credential authorizes management actions without exposing provider API keys to the agent.

## Current boundaries

- Fallback is only possible before response bytes are committed; an active stream cannot move to another provider.
- RPM limits and circuit state are best-effort per isolate. Daily request and Token budgets use KV as their authority.
- Token and cost metrics depend on provider-reported usage. Estimated cost is not a provider invoice.
- Aggregated cost currently has no currency dimension; use one accounting currency per deployment.
- Embeddings, Images, Audio, Realtime, Batch, Files, multi-user accounts, and RBAC are not currently supported.

## Documentation

Start with the [documentation index](docs/README.md).

| Document | Purpose |
|---|---|
| [Product requirements](docs/PRD.md) | Product scope, implementation status, boundaries, and roadmap |
| [Architecture](docs/ARCHITECTURE.md) | Control plane, data plane, storage, caching, and consistency |
| [Detailed design](docs/DESIGN.md) | Protocol conversion, providers, model discovery, analytics, and pricing |
| [Deployment](docs/DEPLOY.en.md) | Deployment, upgrades, rollback, troubleshooting, and quota planning |
| [Testing](docs/TESTING.md) | Unit, UI, controlled-upstream, and real-provider verification |
| [Contributing](docs/CONTRIBUTING.md) | Development workflow and contribution requirements |
| [Security](docs/SECURITY.md) | Vulnerability reporting and deployment responsibilities |
| [Agent guide](AGENTS.md) | Repository constraints for AI-assisted development |

## Contributing

Issues and pull requests are welcome. Read the [contribution guide](docs/CONTRIBUTING.md) before making changes, and report vulnerabilities privately according to the [security policy](docs/SECURITY.md).

MyGateway is released under the [MIT License](LICENSE).
