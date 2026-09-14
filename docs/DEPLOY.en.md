# Deploying MyGateway

[English](DEPLOY.en.md) · [简体中文](DEPLOY.md)

This guide covers deployment, upgrades, rollback, troubleshooting, and quota planning. See the [README](../README.md) for the product overview, [architecture](ARCHITECTURE.md) for system structure, and [testing guide](TESTING.md) for verification.

## 1. Deployment options

| Method | Recommendation | Notes |
|---|---|---|
| Import the Git repository in EdgeOne Makers | Recommended | Browser-based; no local setup |
| Manual build plus console upload | Optional | Requires a local `npm run build:dashboard` |
| Git integration | Recommended | Automatically deploys pushes to the production branch |

## 2. How deployment works

EdgeOne Makers reads `edgeone.json` from the repository root:

1. `installCommand`: `npm install`
2. `buildCommand`: `npm run build:dashboard`
3. `outputDirectory`: `dashboard/dist`, published as static assets
4. Every file under `functions/**` is registered as an edge function; `functions/[[default]].ts` is the catch-all entry
5. Remaining runtime values (`MASTER_KEY`, `INITIAL_ADMIN_PASSWORD`) live in project environment variables, not in the repository

Bind one KV namespace to the project and expose it as the `DB` environment binding. All persistent configuration, usage aggregates, and optional request logs live in that namespace.

Important behavior:

- `edgeone.json` holds build settings only and never contains secrets; every secret is injected through console environment variables.
- `functions/[[default]].ts` only claims `/health`, `/v1/*`, `/admin/api/*`, and `/management/v1/*`. Every other path falls through to `dashboard/dist` via `context.next()`, so console routing is untouched.
- KV is schema-less, so there is no SQL migration step. `src/db/bootstrap.ts` idempotently seeds baseline settings and model prices on the first backend request and never overwrites existing keys.
- The edge entry triggers that seed through `context.waitUntil()`, so the first request is never blocked. A seed failure only records a `kv_seed_failed` event and cannot affect an already returned response.
- `MASTER_KEY` encrypts provider credentials and optional sensitive log context. Generate it once and never delete or rotate it, or existing encrypted data becomes unreadable.
- The administrator password defaults to `mygateway123` and must be changed after the first sign-in. Once changed, `INITIAL_ADMIN_PASSWORD` no longer participates in normal login.
- Passive circuit state is held in isolate memory (3 failures, 30-second cooldown) and needs no additional service.
- Retention cleanup no longer depends on Cron: `POST /admin/api/system/cleanup` runs the analytics, request-log, context, and key-daily-usage cleanup on demand.

For production troubleshooting, inspect `X-Gateway-Timing` for cache, KV lookup, upstream-first-byte, and gateway-first-byte timing. `Server-Timing` is also emitted. Platform logs are sampled and redacted and must not be used as exact request counts.

## 3. Git integration

Connect the project to a Git repository so pushes to `main` trigger a build and deployment:

```text
Git push → EdgeOne Makers build → npm install → Dashboard build
  → static assets and functions/** deployment → production update
```

Recommended settings:

| Field | Value |
|---|---|
| Repository | Your fork, or `Leon00x/mygateway` when deploying the upstream repository |
| Production branch | `main` |
| Install command | `npm install` |
| Build command | `npm run build:dashboard` |
| Output directory | `dashboard/dist` |
| Environment binding | KV namespace → `DB` |
| Environment variables | `MASTER_KEY`, `INITIAL_ADMIN_PASSWORD` |

`edgeone.json` in the repository root is the authoritative source for these values. Keep the console fields aligned with it so the static bundle and the edge functions never drift apart.

## 4. Upgrades and rollback

### Routine upgrades

After a change reaches `main`, EdgeOne Makers builds the console and publishes the static assets together with the edge functions.

- KV has no schema migration, so a new version must read existing data directly. Add new fields with backward-compatible read defaults.
- Normal upgrades do not reset the administrator password or rotate `MASTER_KEY` and provider credentials.
- Routine upgrades preserve the `MASTER_KEY` project environment variable; do not read, replace, or rotate it.
- Run the minimum release checks from the [testing guide](TESTING.md) after a production change.

### Rollback boundary

EdgeOne Makers can roll back to a previous deployment, reverting static assets and edge functions together. KV data does not roll back with the deployment. Prefer additive, compatible, phased data changes, and repair data with new logic instead of deleting production records.

## 5. Common problems

1. **Wrong repository:** the project name is not the Git repository name. Select the real Git repository or fork.
2. **Wrong build command:** only `npm run build:dashboard` produces `dashboard/dist`. Do not reintroduce Cloudflare/Wrangler-era commands.
3. **KV not bound:** without a KV namespace bound as `DB`, every backend route fails because the data binding is missing.
4. **Replaced master key:** never delete or overwrite the production `MASTER_KEY`; existing encrypted provider credentials depend on it.
5. **Secrets committed:** `MASTER_KEY` and `INITIAL_ADMIN_PASSWORD` belong in project environment variables and a local `.env`; `.env` is already ignored by `.gitignore`.
6. **Expecting migrations:** KV has no schema and no SQL step. If the console shows no baseline settings or prices, check the KV binding and the seed log event.

## 6. Diagnostic commands

```bash
# Type check and the fast gate
npm run typecheck
npm run test:fast

# Validate deployment configuration (edgeone.json, entry file, no Cloudflare leftovers)
npm run test:deploy-config

# Build the console bundle manually
npm run build:dashboard

# Trigger a retention cleanup (requires an admin session or management key)
curl -X POST https://your-project.edgeone.app/admin/api/system/cleanup
```

After deployment, verify that the project build succeeded, the console loads, the KV binding is active, and `/health` or one configured model responds. Never paste `MASTER_KEY`, Gateway Keys, Provider Keys, prompts, or full responses into logs or support tickets.

## 7. Quota planning

The default deployment uses:

```text
1 EdgeOne Makers project (static assets + edge functions)
1 KV namespace
2 bootstrap environment variables (MASTER_KEY, INITIAL_ADMIN_PASSWORD)
0 scheduled jobs
```

Quotas change over time; verify the current [EdgeOne Makers documentation](https://edgeone.ai/document/177158575068948480) before production use. KV read and write amplification, not request count alone, is the main capacity driver.

MyGateway stays lightweight by:

- caching bounded hot configuration in isolate memory, so cache hits never touch KV; cold requests resolve auth and routing with a few `get`s, and unique index keys (`gateway_key_hash:*`, `management_key_hash:*`, `admin_user_name:*`) keep those lookups from degrading into full scans;
- committing usage, key usage, and optional logs in one `waitUntil()` batch without delaying the model response;
- skipping quota reads when a key has no period budget, while limited keys perform at most one range aggregation per isolate every 30 seconds by default;
- running retention cleanup on demand (`POST /admin/api/system/cleanup`) instead of a daily Cron, keeping at least 370 days of key daily usage;
- keeping passive circuit breakers and RPM windows in isolate memory instead of KV.

If KV quota is exhausted, configuration-dependent routes may return 503. Failed analytics writes or dashboard queries do not invalidate an already completed provider response. If representative traffic approaches the project quota, reduce optional logging and analytics overhead or upgrade the project plan—do not bypass authentication or streaming correctness.
