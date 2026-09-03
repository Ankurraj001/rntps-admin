# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A school management system (students, attendance, fees, WhatsApp fee reminders) for a single
school (~200 students). npm workspaces monorepo: `packages/shared` (zod schemas + pure helpers,
imported by **both** sides so the API contract is typed end to end with no codegen) → `apps/api`
(Express 5 + Mongoose) → `apps/web` (React 19 + Vite). See README.md for full product/domain
documentation — it is extensive and authoritative; skim it before making non-trivial changes to
fees, attendance, or auth, since most business rules there are backed by a test named after the
rule (`sunday.test.ts`, `calculationChain.test.ts`, `feeSlip.test.ts`, etc.).

## Commands

```bash
npm install
npm run build -w @rntps/shared     # required once before dev/build — api & web import shared from dist, not src
cp .env.example apps/api/.env
npm run seed:settings              # one-time: creates the settings singleton
npm run dev                        # api on :4000, web on :5173 (runs both workspaces)
npm run dev:api                    # api only
npm run dev:web                    # web only
```

- `npm test` — API unit + HTTP integration tests only (`npm run test -w @rntps/api`; there is no
  root vitest). Uses `mongodb-memory-server`, no external DB, no `.env` needed.
- Single test file: `npm run test -w @rntps/api -- attendance.routes.test.ts` (or `cd apps/api &&
  npx vitest run <path>`). Watch mode: `npm run test:watch -w @rntps/api`.
- `npm run typecheck` — every workspace (`tsc -b`/`--noEmit`).
- `npm run lint` — root ESLint flat config, whole repo.
- `npm run build` — shared → api → web, in that order (web/api both import `@rntps/shared`'s
  built `dist`, so building out of order breaks the other two).
- `npm run test:e2e` — Playwright, against a **running** dev stack (needs `npm run dev` already
  up in another shell) plus a seeded admin: `E2E_ADMIN_EMAIL=... E2E_ADMIN_PASSWORD=... npm run
  test:e2e`. Not part of CI (`if: false` in `.github/workflows/ci.yml`) because it needs a full
  stack + database.
- `npm run indexes:sync` — required after any schema/index change and after every fresh deploy;
  production runs with `autoIndex: false`.
- `npm run seed:admin -- "Name" email@school`, `npm run reset:password -- email@school`,
  `npm run mail:test -- you@example.com` — operational scripts, see README "Operations" section.

CI (`.github/workflows/ci.yml`) runs, in order: build shared → typecheck → lint → test → build.
Match that order locally when debugging a CI-only failure.

## Architecture

**Workspace boundary:** `packages/shared/src/schemas/*` is the single source of truth for
request/response shapes (zod). The API validates against these schemas via
`middleware/validate.ts`; the web app derives its TypeScript types and its own `react-hook-form`
validation from the same schemas. Changing a shape means editing shared, rebuilding it
(`npm run build -w @rntps/shared`), then updating both consumers — a common source of confusing
type errors is forgetting the rebuild step, since both apps import from `@rntps/shared`'s `dist`,
not its `src`.

**API module layout** (`apps/api/src/modules/<name>/`): each module is
`<name>.routes.ts` (Express router + `requireAuth`/`requireRole`/`requireClassAccess` wiring) +
`<name>.service.ts` (business logic, framework-agnostic) + colocated `*.test.ts`. Routes are thin;
domain rules and the calculations documented in README live in the service files (and in
`packages/shared` for logic needed by both sides, e.g. `concessionFor()` in
`packages/shared/src/schemas/fees.ts`, `feeMessage.ts` formatting). `app.ts` is the single place
that wires all module routers under `/api/v1/*`; `index.ts` runs it as a normal Node server for
local dev, `netlify.ts` wraps the same `createApp()` with `serverless-http` for production — there
is one Express app, two entry points.

**Auth model** (`middleware/auth.ts`): `requireAuth()` populates `req.user` from a bearer JWT;
`requireRole('ADMIN', ...)` gates by role; `requireClassAccess()` confines a `TEACHER` to their
assigned classes and deliberately reads the class code from params, query, *or* body so it can't be
bypassed by moving the parameter. Access token is short-lived and held client-side in memory
(never `localStorage`); the refresh token is an `httpOnly` cookie with rotation + reuse detection.
Errors are `AppError` (`lib/AppError.ts`) with an HTTP status + stable `code`, caught by the single
`errorHandler` middleware — throw/pass an `AppError` rather than a raw one when a handler needs to
fail with a specific status. Full rationale (grace windows, lockout being DB-backed rather than
IP-based, password reset flow, etc.) is in README's "Authentication" section — read it before
touching anything in `modules/auth` or `middleware/auth.ts`.

**Data model conventions** (see README "Architecture notes" for the full rationale):
- Most collections key on a meaningful string `_id` instead of an ObjectId, which doubles as a
  uniqueness constraint and makes some invariants structural rather than checked in code:
  `students` → studentId, `invoices` → `{studentId}:{period}`, `attendance` →
  `{studentId}:{dateKey}`, `feeStructures` → `{classCode}:{year}`.
- All money is **integer rupees** (never paise, never a float) — `.int()` is enforced at the zod
  schema boundary; a fractional amount is rejected, not rounded/truncated.
- Dates that matter for business logic (attendance, fee periods) are `dateKey` strings
  (`YYYY-MM-DD`) computed in Asia/Kolkata, not raw `Date` comparisons — see `packages/shared/src/date.ts`.
- Everything targets a single document per write (no multi-document transactions), which is why no
  replica set is required even against a standalone `mongod`.

**Web app layout** (`apps/web/src/`): `api/*.ts` are thin fetch wrappers per domain consumed via
TanStack Query; `auth/AuthProvider.tsx` + `RouteGuards.tsx` implement the in-memory-access-token /
single-flight-refresh pattern described in README; `router.tsx` is the single route table, with
admin-only routes wrapped in `RequireRole` (a UI convenience — the API enforces the same boundary
independently, so don't treat a frontend guard as the security control when changing permissions).
Pages are grouped by feature under `pages/<feature>/`, mirroring the API's module names.

**Deployment:** frontend and backend deploy together to one Netlify origin (see `netlify.toml`),
specifically so the refresh cookie can stay `SameSite=Strict` and first-party. `/api/*` rewrites to
one Netlify Function (`netlify/functions/api.mjs` → `apps/api/src/netlify.ts`); everything else
falls back to the SPA. `NPM_FLAGS = "--include=dev"` in `netlify.toml` is load-bearing — without it
`devDependencies` (TypeScript, Vite) are skipped and the build fails. Don't add a real secret's key
name to `SECRETS_SCAN_OMIT_KEYS` in `netlify.toml`; it exists only for non-secret values that are
already documented in README/`.env.example`.
