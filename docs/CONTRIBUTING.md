# Contributing to MyGateway

[English](CONTRIBUTING.md) · [简体中文](CONTRIBUTING.zh-CN.md)

Thanks for your interest in MyGateway. The project is small by design: it runs
on EdgeOne Makers, prefers one Blob storage binding + isolate memory over shared state, and
prioritizes "simple to run and understand" over enterprise features.

## Project principles

- **Free allowance first.** No self-hosted services, no R2/Queues/Durable
  Objects, and no extra storage bindings unless the free allowance keeps working.
- **Simple and predictable.** Fixed-priority routing, pre-response fallback,
  and no hidden background probing.
- **Easy to use.** One key, one console; sensible defaults that work out of the
  box. Prompt/response previews are off by default and only stored as encrypted,
  short-lived 4 KiB previews when the admin explicitly opts in.
- **Honest numbers.** Tokens and spend come from provider-reported usage;
  unknown usage is flagged, never guessed.

## Setting up

```bash
npm install
cp .env.example .env     # set INITIAL_ADMIN_PASSWORD and a local MASTER_KEY
npm run dev              # console dev server on http://localhost:5173
```

Admin login on first run uses the bootstrap credentials documented in
[README.md](../README.md) (change them after login).

The gateway backend runs on the edge function runtime. To exercise `/v1/*`,
`/admin/api/*`, and `/management/v1/*` end to end, deploy a preview of your
EdgeOne Makers project and point the console at it.

## Development loop

```bash
npm run test:fast          # docs, types, unit tests, Dashboard build, deploy config
npm run test:api           # Admin and Management HTTP contracts
npm run test:ui            # browser user journeys
npm run test:system        # controlled-upstream routing and streaming
npm run test:sit           # opt-in real integrations; consumes Provider usage
```

Before opening a PR make sure:

1. `npm run test:fast` passes.
2. Run every affected layer from the testing activity matrix.
3. Release maintainers run `npm run test:release`; contributors without SIT credentials use `test:release:local`.
4. Blob object paths are defined in `src/kv/keys.ts`; there is no SQL schema to migrate.
5. New user-visible behavior is documented in `docs/PRD.md`; implementation
   details go in the relevant architecture or design document without copying
   the same section into every file.

## Where things live

| Path | Purpose |
|---|---|
| `functions/` | Edge function entry (catch-all route + static asset fallthrough) |
| `src/gateway/` | `/v1/*` request path: auth, routing, fallback, quota, caching |
| `src/admin/` | `/admin/api/*` control plane |
| `src/db/` | Domain data access over Blob storage |
| `src/kv/` | Object path prefixes and JSON/pagination helpers |
| `migrations/` | Historical SQL baseline (read-only reference; not executed) |
| `dashboard/` | SolidJS admin console (static assets published by EdgeOne Makers) |
| `test/` | Vitest unit tests |
| `e2e/` | Playwright UI, API, controlled-upstream, and real-provider suites |

## Commit conventions

Commits follow conventional style, e.g. `feat:`, `fix:`, `docs:`, `refactor:`.
The `docs/TESTING.md` table should stay accurate.

## Getting help

Open an issue for questions and feature requests. Discuss the trade-off before
implementing — we routinely decline features that would break the free tier
or the "simple to run" promise.
