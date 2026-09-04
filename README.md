# RNTPS Admin

School management system for RNTPS — student records, fees and attendance for ~200 students.

**Status: complete.** Students, attendance, fees, WhatsApp fee reminders, reports and role-based
auth are all built, tested and deployable.

## Stack

| Layer | Choice |
|---|---|
| Web | React 19 · Vite · TypeScript · TanStack Query · Tailwind 4 · react-hook-form |
| API | Node 22 · Express 5 · TypeScript · Mongoose 8 · zod · pino |
| Database | MongoDB (local `mongod` for dev, Atlas for production) |
| Tests | Vitest · supertest · mongodb-memory-server |

A `packages/shared` workspace holds the zod schemas used by **both** sides, so the API contract is
typed end to end without a codegen step.

## Prerequisites

- Node 22+
- A MongoDB database — either MongoDB Atlas (recommended, works for dev too) or a local `mongod`

No Docker and no replica set are required: every write in this system targets a single document, so
a standalone `mongod` is enough if you prefer running locally.

### Option A — MongoDB Atlas (recommended)

1. Create a free **M0** cluster at [cloud.mongodb.com](https://cloud.mongodb.com). Pick the region
   closest to the school (`ap-south-1` Mumbai for India) — this is permanent on M0.
2. **Database Access** → add a user with **`readWrite` on the `rntps` database only**, not
   `atlasAdmin`.
3. **Network Access** → add your current IP. (Timeouts later usually mean your IP changed.)
4. **Connect → Drivers → Node.js** and copy the string. Two edits are required:
   - **Add the database name** before the `?`: `.../rntps?retryWrites=true...`. Atlas omits it, and
     without it Mongoose silently writes to a database called `test`.
   - **URL-encode the password** if it contains `@ : / ? # [ ] %`:
     `node -e "console.log(encodeURIComponent('your-password'))"`

### Option B — local mongod

Homebrew's MongoDB lives in a third-party tap, which recent Homebrew versions refuse to load until
you explicitly trust it:

```bash
brew trust mongodb/brew          # one-time, review the tap first
brew services start mongodb-community
```

To avoid changing your Homebrew trust settings, run `mongod` directly instead:

```bash
mkdir -p ~/.rntps/mongo-data
mongod --dbpath ~/.rntps/mongo-data --bind_ip 127.0.0.1 --port 27017
```

## Getting started

```bash
npm install
npm run build -w @rntps/shared   # API and web import this package from dist
cp .env.example apps/api/.env    # then adjust if needed
npm run seed:settings            # creates the singleton settings document
npm run dev                      # api on :4000, web on :5173
```

Check the connection with `curl localhost:4000/readyz` — it returns
`{"status":"ready","database":true}` once Mongo answers. A `503` is almost always one of:
`Authentication failed` (password wrong or not URL-encoded), `Could not connect to any servers`
(IP not allowlisted in Atlas), or an SRV/DNS failure (some corporate networks block SRV lookups).

Open http://localhost:5173.

`seed:settings` is safe to re-run — an existing settings document is left untouched so the ID
counters are never reset.

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Runs the API and web dev servers together |
| `npm run dev:api` / `npm run dev:web` | Runs one side only |
| `npm test` | Vitest unit + HTTP integration tests |
| `npm run typecheck` | Typechecks every workspace |
| `npm run lint` | ESLint across the repo |
| `npm run build` | Builds shared → api → web |
| `npm run seed:settings` | Creates the settings singleton |
| `npm run seed:admin -- "Name" email@school` | Creates an admin and prints a one-time password |
| `npm run reset:password -- email@school` | Break-glass password reset when nobody can sign in |
| `npm run mail:test -- you@example.com` | Verifies the mail transport before anyone relies on it |
| `npm run report:daily -- [YYYY-MM-DD]` | Sends the daily collection email by hand; defaults to today |
| `npm run report:expenses -- [YYYY-MM]` | Sends the monthly expense email by hand; defaults to this month |
| `npm run test:e2e` | Playwright end-to-end tests against a running stack |
| `npm run indexes:sync` | Builds the schema indexes by hand; the deploy runs it automatically, see below |
| `npm run db:stats` | Reports size and index usage per collection against the 512 MB Atlas M0 budget |
| `npm run migrate:rupees --workspace @rntps/api` | One-off paise → rupees conversion; `--dry-run` reports without writing |
| `npm run migrate:drop-plaintext` | One-off: unsets the old readable-password field; `--dry-run`, `--force-rotation` |
| `npm run tokens:clear-expired --workspace @rntps/api` | Housekeeping: clears expired reset tokens; `--dry-run` |


## Testing

```bash
npm test           # 365 unit + HTTP integration tests (mongodb-memory-server, no external DB)
npm run test:e2e   # 10 Playwright end-to-end tests against a running stack
```

The API suite covers the money and access paths in depth: invoice double-billing, concurrent
payments, overpayment, reversal arithmetic, refresh-token rotation and reuse detection, account
lockout across containers, and every teacher-versus-admin boundary.

E2E needs both dev servers running and an admin account, supplied explicitly — there is no default,
because a hard-coded account would mean a live admin with a known password sitting in whatever
database the suite points at:

```bash
npm run seed:admin -- "E2E Bot" e2e@rntps.local     # prints a temporary password
# sign in once to set a real password, then:
E2E_ADMIN_EMAIL=e2e@rntps.local E2E_ADMIN_PASSWORD=... npm run test:e2e
```

Prefer a staging database, and deactivate the account when finished. `E2E_BASE_URL` points the suite
at a Netlify preview instead of localhost.

**A known rough edge:** roughly one full API run in five used to see a single test fail, with the
culprit moving between files while every file passed 10+ consecutive runs in isolation. That points at
the in-memory mongod's connect/drop/disconnect lifecycle rather than at the code, so
`apps/api/vitest.config.ts` sets `retry: 1`. It is a mitigation, not a fix — if something starts
failing on the retry as well, treat it as a real defect rather than raising the retry count.

Three things worth knowing if you extend the E2E suite — each cost real debugging time:

- **It shares one sign-in per spec file.** Signing in per test exceeds the real `/auth/login` rate
  limit (10 per minute per IP), a safeguard worth keeping rather than loosening for tests.
- **Never aim a deliberate bad-password test at the shared account.** Five failures lock it for
  fifteen minutes, and every other test then fails for an unrelated-looking reason. Use an address
  that does not exist.
- **`page.goto()` resolves before React mounts.** Wait for a control
  (`waitFor({ state: 'visible' })`) before reading its contents; otherwise a locator returns nothing
  and the test can silently skip itself.

## Architecture notes

**Meaningful primary keys.** Most collections use a readable string `_id` rather than an ObjectId,
which doubles as the uniqueness constraint:

| Collection | `_id` | Example |
|---|---|---|
| `students` | the studentId | `RNTPS-26-001` |
| `invoices` *(phase 4)* | `{studentId}:{period}` | `RNTPS-26-001:2026-08` |
| `attendance` *(phase 3)* | `{studentId}:{dateKey}` | `RNTPS-26-001:2026-08-25` |
| `feeStructures` *(phase 4)* | `{classCode}:{year}` | `5:2026-27` |
| `settings` | fixed literal | `app` |
| `users` *(phase 2)*, `notifications`, `auditLogs`, `expenses` | ObjectId | — |

Keying an invoice by student-and-period makes double-billing structurally impossible; keying
attendance by student-and-day does the same for double-marking. Neither needs an application check.

**Siblings are a shared `familyId`,** not a duplicated list on each student. Linking a sibling during
onboarding makes the new record join that family and pre-fills the guardian and address details. Fee
reminders then group by family, so a parent with three children gets one message rather than three.

**Money is integer rupees,** never a float. `₹1,800` is stored as `1800` — the same number the admin
typed, all the way from the form to the database, with no conversion step anywhere.

*Integer* is the load-bearing word. School fees are always whole rupees, so paise bought nothing but
arithmetic; floats would still misbehave (`0.1 + 0.2 !== 0.3`) and the error compounds across a year
of invoices and part-payments. So `.int()` guards every amount at the API edge, and a fractional
amount is **rejected rather than truncated** — a receipt saying ₹500 for a ₹500.75 payment is a
reconciliation problem discovered months later. `formatINR()` in `packages/shared/src/money.ts` is
display only.

Two consequences worth knowing:

- A **percentage concession rounds to the nearest rupee**, and a half-rupee remainder goes the
  student's way: 10% of ₹1,255 is ₹126, not ₹125.50.
- A **flat concession must be a whole number of rupees.** A percentage may be fractional, because
  12.5% is a real thing a school offers.

Amounts already stored in paise are converted by `npm run migrate:rupees --workspace @rntps/api`
(add `--dry-run` to see the report first). It is idempotent — it selects documents by the presence of
the old field, so a second run finds nothing — and it lists any amount that was not a whole number of
rupees rather than silently absorbing the remainder.

**Days are `dateKey` strings** (`"YYYY-MM-DD"`) computed in Asia/Kolkata. Comparing raw `Date`
objects across timezones produces off-by-one-day attendance bugs.

**Single-document writes.** Payments will be embedded in their invoice, so recording a payment is one
atomic update pipeline rather than a multi-document transaction. This is what removes the replica-set
requirement.

**Classes** are the fixed list `NURSERY, LKG, UKG, 1…8` with no sections — a shared constant, not a
collection.


## Authentication

**Access token in memory, refresh token in an httpOnly cookie.** The access token is a 15-minute
JWT held in a JavaScript variable — never `localStorage`, which any XSS could read and which would
outlive the tab. The long-lived credential is an `httpOnly; Secure; SameSite=Strict` cookie scoped to
`/api/v1/auth`, which JavaScript cannot touch. A page reload starts with no access token and
exchanges the cookie for a fresh one.

**Refresh tokens rotate, with reuse detection.** Each refresh issues a new token and marks the old
one rotated. Presenting an already-rotated token means it was captured and replayed, so the whole
token *family* is revoked — signing out the legitimate user too, which is the right response to a
stolen session.

There is a **10-second grace window** on that check. Two browser tabs bootstrapping at once (or React
StrictMode double-invoking the effect in development) all send the same cookie before any of them has
the new one; without the window, users would be signed out on nearly every page load. The client also
funnels every refresh — bootstrap, scheduled renewal, and the 401 retry — through one single-flight
promise, so the grace path is rarely needed.

**A rotated token is kept for 24 hours, then dropped.** It is useless for authentication the moment
it rotates, but it is the tripwire that makes reuse detectable, so it cannot be discarded at
rotation. It was previously kept until `expiresAt` — the full `REFRESH_TOKEN_TTL_DAYS`. Because the
client renews on a timer rather than on a 401, a tab left open through a working day rotates about
every 14 minutes, which left roughly 475 spent entries (~120 KB) inside one user document, each one
also indexed by `refreshTokens.tokenHash`, and the whole document rewritten on every rotation. Ten
staff accounts outweighed all 250 student records.

A day is 8,640× the grace window and far longer than any real replay takes. The trade-off is
explicit: a token replayed for the first time more than a day after rotation is still refused, but no
longer revokes its family, so nobody learns it leaked. Theft of a *live* token — the case that
matters — is unaffected.

**Passwords use `scrypt` from `node:crypto`**, not argon2 or bcrypt. Both of those are native addons,
and native addons inside a bundled serverless function are a reliable source of cold-start failures.
Parameters are the OWASP minimum (N = 2¹⁷, r = 8, p = 1, ~200ms) and are stored *with* each hash, so
they can be raised later without invalidating existing passwords — a weaker hash is upgraded
transparently at next sign-in.

**Brute-force protection is database-backed account lockout**, not IP rate limiting: 5 failed attempts
locks the account for 15 minutes. This is deliberate. On Netlify each warm container has its own
in-memory rate-limit counter, so N containers would allow N times the limit — but every container
shares the database. The per-IP limiter in front of `/auth/login` is a cheap extra layer, not the
real defence.

**Login errors are deliberately identical** for unknown email, wrong password and deactivated
account, and an unknown email still pays the cost of a hash comparison. Otherwise anyone could
enumerate which staff addresses exist, by response body or by timing.

**Roles.** `ADMIN` reaches everything. `TEACHER` gets a read-only student directory and (from phase 3)
attendance for their assigned classes only. `requireClassAccess` reads the class from params, query
*or* body, so a teacher cannot reach another class by moving the parameter. Whole-family guardian
contact details are admin-only. The frontend hides what a teacher cannot do, but the API enforces it
independently — the UI guard is convenience, not security.

**Passwords arrive by email, never by hand.** Creating a user emails them a single-use link to
choose their own password; an admin reset does the same. The account is parked on a hash of random
bytes nobody holds until the link is used, so the old password stops working the moment a reset is
requested. Both operations return no password in the response body — there is nothing for an admin to
read out, overhear or screenshot.

**Forgotten password.** `POST /auth/forgot-password` emails a single-use link. The token is 256 bits
of randomness stored only as a SHA-256 hash, so a database leak yields nothing replayable. Reset
links last `PASSWORD_RESET_TTL_MINUTES` (default 60); invitations last `INVITE_TTL_HOURS` (default 72),
since they are often handed out before term starts. Completing either consumes the token, clears any
lockout, revokes every existing session, and records the address as confirmed.

The endpoint always answers `204` — telling the caller "no such account" would turn it into a
staff-directory oracle. Four things sit behind it:

- **Two rate limits, not one.** 5 requests per 15 minutes per IP on `/forgot-password`, and a separate
  budget on `/reset-password`. They used to share a single limiter, which meant a user who asked for
  two links could be refused the chance to actually set a password.
- **A per-account throttle, in the database.** Three links an hour per account. The IP limit is
  best-effort on serverless — each warm container counts separately — so an attacker rotating addresses
  could otherwise flood one inbox. This counter is shared by every container, like the account lockout.
- **The token is withdrawn if the email fails.** A send that reports failure clears the hash again.
  Leaving a live credential-reset path in the database for a message nobody received is worse than not
  having tried.
- **Changing a password kills any link in flight.** A self-service change, an admin reset and the
  break-glass script all clear the pending token. Without that, whoever requested a reset kept a
  working link for the rest of its lifetime *after* the victim secured the account.

**With no mail transport configured, self-service reset is switched off rather than faked.** This
matters: the page used to accept an address, mint a token and say "check your email" on a server that
could not send one, leaving the user waiting for a message that never came. Now:

- `GET /auth/config` (public) reports `passwordResetByEmail` and the real link lifetime. It reflects
  whether mail can actually be *delivered* — the transport is asked, and the answer cached for five
  minutes per container — not merely whether credentials are set, so a revoked API key does not leave
  the page promising email. It reveals only whether the server can send at all, never whether an
  account exists.
- The forgotten-password page asks first. With email unavailable it shows the recovery path that
  actually works — **ask an administrator** — instead of a form that leads nowhere.
- `POST /auth/forgot-password` mints no token in that state.
- Account creation falls back to a one-time password shown to the admin once, so onboarding never
  hard-blocks on mail.

In development with no credentials the link is still written to the server log, which is what a
developer needs. `npm run tokens:clear-expired --workspace @rntps/api` clears expired reset tokens;
it is housekeeping, not a security control, since expiry is enforced in code. Deliberately a script
and **not** a TTL index — Mongo TTL deletes the whole document, which on `users` would delete the user.

**Every credential event is audited.** `auth.password-reset-requested` (recorded even for unknown
addresses, which is how enumeration shows up after the fact), `auth.password-reset-completed`,
`auth.password-changed`, `auth.login-blocked`, and `user.invited`. Secrets are scrubbed before the row
is written.

**No password is ever readable.** Only the scrypt hash is stored. There is no field, endpoint or
screen that can return a user's password, and nobody — including an admin — can look one up. An
earlier `STORE_PLAINTEXT_PASSWORDS` flag kept a readable copy alongside the hash; it and its
`GET /users/:id/password` endpoint have been removed, because anyone who obtained the database — or
just the connection string, reachable from anywhere given Netlify's non-static function IPs — would
have held every staff password in usable form. Recovery is a fresh emailed link, not a lookup.

**First sign-in.** `npm run seed:admin` prints a one-time password. Any user with a temporary password
is authenticated but confined to `/auth/me`, `/auth/change-password` and `/auth/logout` until they set
their own, so a handed-over password cannot be used to browse student records indefinitely.

## Features

**Students** — onboarding with sibling linking (shared `familyId`, guardian and address pre-filled
from the sibling), searchable directory, editing from either the list row or the student page, status
transitions (records are never deleted), and a guided **year rollover** that copies the fee structures
forward, moves the new session in, and promotes every student one class with class 8 graduating to
alumni.

Each student can carry an **Aadhaar number** and an **APAAR ID / PEN**, both optional and unique
across the school, and both searchable — so a student can be found from a government form. Aadhaar is
validated against its Verhoeff check digit, which catches every single-digit typo and every
transposition of adjacent digits; twelve digits copied off a card by hand get both wrong regularly.
APAAR/PEN validation is deliberately loose (8–20 alphanumeric), because the format varies by state and
by whether the school is on APAAR or an older UDISE+ scheme.

Emptying an identifier on edit *clears* it, rather than leaving the old value in place. That matters
because these fields are unique: a number entered against the wrong student would otherwise
permanently block the student it actually belongs to.

Aadhaar is stored and displayed in full, by choice. UIDAI's guidance is to mask to the last four
digits outside authentication contexts; `maskAadhaar()` in `packages/shared/src/identifiers.ts` is
there if you want to switch display over later.

Edits are partial and validated the same way as onboarding. The studentId and the family link are
immutable afterwards — those keys are stripped from an update rather than applied, since the studentId
is the primary key and appears on issued receipts.

**Attendance** — one record per student per day, keyed `studentId:dateKey` so double-marking is
impossible. Three states only — **present, absent, holiday** — and **Sundays are holidays
automatically**. Keyboard-driven roster (everyone starts Present; P/A/H set a status and advance),
monthly grid, per-student history, below-threshold defaulter report, and a dashboard nudge for classes
not yet marked today. **Teacher attendance** is the same register with "Teachers" chosen instead of a
class — see below for what it deliberately does not feed into.

**Fees** — monthly fee heads per class (including transport-only heads), **per-student transport
fares**, percentage or flat concessions, invoice runs that preview before committing and cannot double-bill, payment recording
with sequential receipt numbers, reversal that keeps the record, voiding, and printable receipts.

**Fee reminders** — WhatsApp click-to-chat batches grouped by guardian phone number, so a parent with
three children gets one message rather than three. Each child's bill is **itemised** — a line per fee
head and charge, then the adjustments — and arrears are carried in. Resumable: progress is stored
server-side.

**Reports** — dues with aging buckets, collection by date range and mode, attendance defaulters. Each
exports to CSV.

The collection report lists **newest receipt first** and includes **reversed payments**, flagged and
struck through rather than hidden. A bounced cheque still had a receipt handed to a parent, so
dropping it makes a real receipt number vanish and leaves whoever is reconciling against the bank
with an unexplained gap. It is never added in, though: `totals.count` and `totals.amountRupees` see
only what the school kept, reversals are reported separately as `reversedCount` and `reversedRupees`,
and the CSV carries a `Status` column so summing the amount column in a spreadsheet cannot count one.
The dashboard's collection figure reads the same totals and is likewise unaffected.

A reversal is dated independently of the payment: a receipt taken on the 5th and reversed on the 20th
still belongs to a 1st-to-10th report, shown as reversed. Matching on the reversal date instead would
make the money look collected in any report that closed before the cheque bounced.

**Access** — admin and teacher roles. Teachers get a read-only student directory and attendance for
their assigned classes only; anything touching money, users or settings is admin-only.

## API

Base path `/api/v1`. Health probes are unprefixed: `GET /healthz`, `GET /readyz`.

Everything except the health probes requires a signed-in user. **A** = admin only,
**A/T** = admin or teacher.

```
      POST   /auth/login                          email + password -> access token + refresh cookie
      POST   /auth/refresh                        rotates the refresh cookie
      POST   /auth/logout
      GET    /auth/config                         public: whether reset-by-email is available
      POST   /auth/forgot-password                emails a single-use reset link; always 204
      POST   /auth/reset-password                 consumes the token, revokes every session
A/T   GET    /auth/me
A/T   POST   /auth/change-password                revokes every session

A     GET    /users
A     POST   /users                               emails a setup link; password only if mail is down
A     PATCH  /users/:userId
A     POST   /users/:userId/deactivate | /activate
A     POST   /users/:userId/reset-password         break-glass only, no UI; see Recovering access
A     POST   /users/:userId/unlock

A/T   GET    /students                            list, search, filter, paginate
A     POST   /students                            onboard (auto-generates the studentId)
A/T   GET    /students/:studentId
A     PATCH  /students/:studentId
A     POST   /students/:studentId/status          ACTIVE | INACTIVE | TC_ISSUED | ALUMNI
A     GET    /students/:studentId/charges          pending + billed charges
A     POST   /students/:studentId/charges          add a charge; billed by the next invoice run
A     DELETE /students/:studentId/charges/:chargeId remove one that is not billed yet
A/T   GET    /students/:studentId/siblings
A     GET    /students/:studentId/family-defaults guardians + address, for pre-filling
A     GET    /students/search-sibling?q=
A     POST   /students/promote                    year rollover; dryRun defaults to true
A     GET    /students/rollover-status            which rollover steps are still outstanding
A/T   GET    /students/stats

A/T   GET    /attendance/roster?classCode&dateKey  teacher: assigned classes only
A/T   PUT    /attendance/roster                    idempotent bulk upsert
A/T   GET    /attendance/monthly?classCode&month
A     GET    /attendance/staff/roster?dateKey      the teacher register
A     PUT    /attendance/staff/roster              only an admin marks teachers
A/T   GET    /attendance/staff/monthly?month       read-only, whole register
A     GET    /attendance/defaulters?month&threshold
A/T   GET    /attendance/unmarked                  scoped to the caller's classes
A/T   GET    /attendance/student/:studentId

A     GET    /fees/structures
A     GET|PUT /fees/structures/:classCode/:academicYear
A     POST   /fees/structures/clone                copy a year forward
A     POST   /fees/runs/preview                    dry run — always shown first
A     POST   /fees/runs/commit
A     GET    /fees/invoices                        status, class, period, overdue filters
A     GET    /fees/invoices/:invoiceId
A     GET    /fees/invoices/:invoiceId/slip       bill to hand a parent: this month + arrears
A     POST   /fees/invoices/:invoiceId/payments
A     POST   /fees/invoices/:invoiceId/payments/:receiptNo/reverse
A     POST   /fees/invoices/:invoiceId/void
A     GET    /fees/students/:studentId/invoices

A     GET|POST /notifications                      build a reminder batch
A     GET    /notifications/:batchId
A     PATCH  /notifications/:batchId/items/:itemKey  queue progress

A/T   GET    /reports/dashboard                   also carries the school name + academic year
A     GET    /reports/dues?format=csv
A     GET    /reports/collection?from&to&format=csv

A     GET    /expenses?month=YYYY-MM              the whole Expenses tab in one response
A     POST   /expenses
A     DELETE /expenses/:id                        the one hard delete; audited with its values

A     GET    /settings                            admin-only: exposes the ID prefix and counters
A     PATCH  /settings
```

## Deploying — Netlify (frontend + backend together)

Both halves deploy to **one origin**, `https://rntps-admin.netlify.app`:

```
/            -> React SPA          (apps/web/dist)
/api/*       -> Express API        (Netlify Function, rewritten in netlify.toml)
```

Same-origin is a deliberate choice, not a convenience. It keeps the auth refresh cookie
`SameSite=Strict` and **first-party** — a split frontend/backend deployment would make it a
third-party cookie, which Safari blocks outright and Chrome is phasing out. It also means no CORS
in production; `CORS_ORIGINS` only matters for local dev, where the two run on different ports.

### How it fits together

| File | Role |
|---|---|
| `netlify.toml` | Build command, publish dir, `/api/*` rewrite, SPA fallback, security headers |
| `netlify/functions/api.mjs` | Netlify entry — a one-line re-export |
| `apps/api/src/netlify.ts` | The real handler: wraps `createApp()` with `serverless-http`, normalises the path, ensures the DB connection |
| `apps/web/.env.production` | `VITE_API_URL=/api/v1` — relative, so the SPA calls its own origin |

The handler lives in the api workspace rather than in `netlify/functions` so it is typechecked,
linted and tested with the rest of the backend.

### First deploy

1. Connect the repo in Netlify. It reads `netlify.toml`, so no dashboard build config is needed.
2. Set **one** environment variable in Netlify → Site configuration → Environment variables:

   | Key | Value |
   |---|---|
   | `MONGODB_URI` | your Atlas string, including `/rntps` and a URL-encoded password |
   | `NODE_ENV` | `production` |
   | `JWT_SECRET` | a 32+ byte random string (`openssl rand -base64 48`) |

   `NODE_ENV=production` is required at runtime — it is what makes the refresh cookie `Secure`. Note
   that npm reads the same variable during install and skips `devDependencies`, where TypeScript and
   Vite live, so the build fails with `sh: 1: tsc: not found` and exit code 127. `netlify.toml` sets
   `NPM_FLAGS = "--include=dev"` to force them in. If you ever see 129 packages installed instead of
   ~538, that is this.

3. **Atlas → Network Access → add `0.0.0.0/0`.** Netlify's function IPs are not static. The
   database user password remains the real gate.
4. Deploy, then from your machine:
   - `npm run indexes:sync` — `autoIndex` is off in production, so indexes are not created
     automatically. Required before anything relies on the unique email or roll-number constraints.
   - `npm run seed:admin -- "Your Name" you@school.example` — creates the first admin and prints a
     one-time password. Point `MONGODB_URI` at the production cluster when you run it.

### Serverless caveats that shaped the code

- **Connection caching** (`apps/api/src/config/db.ts`) — the connect promise is cached at module
  scope with `maxPoolSize: 5`. Without it, every invocation opens a new pool and Atlas eventually
  refuses connections.
- **Rate limiting is best-effort.** Each warm container keeps its own in-memory counter, so N
  containers allow N times the limit. `clientIp()` reads Netlify's `x-nf-client-connection-ip`
  because `req.ip` is undefined without a socket. Real brute-force protection is the database-backed
  account lockout in the auth module, which every container shares.
- **Cold starts** are roughly 1–3s after idle.
- **Function timeout** is ~10s on the free tier. Every operation in the plan — including the
  200-student invoice run — completes in well under a second at this scale.
- **Mongoose is `external_node_modules`**, since esbuild cannot follow its runtime driver
  resolution.


### Transport fares

The class fee structure holds the transport head as the **default** fare. Any student can carry their
own amount in `transportFareOverrideRupees`, set on their record — for distance, stop, or any other
reason. When present it replaces the class transport amount for that student only, keeping the head's
name so the invoice still reads "Transport".

- `transportOpted` decides **whether** transport is billed; the fare decides **how much**. A fare set
  on a student not marked as using transport is not billed, and the invoice-run preview says so
  rather than dropping it silently.
- **Blank means "use the class default"**, stored as `null`. **Zero is a real fare** — for a child who
  travels free — so the two are deliberately different values.
- Raising the class transport head moves everyone **without** an override, and leaves overridden
  students alone. That is the point of the split.
- The preview marks overridden rows, so a run is auditable at a glance.
- A discount applies to the transport fare as well as tuition, since both are the school's own fee
  lines. It does not apply to one-off charges — see "A concession does not apply to charges" below.

### Discounts

A student can carry a **standing monthly discount**, set as **Discount (₹)** on their record next to
the transport fare. It is a whole number of rupees, and it comes off **every** monthly invoice for
that student until it is changed — this is the only per-student discount there is, and it is
deliberately not a per-invoice one.

- **Blank means no discount.** Any amount is stored as a `FLAT` concession
  (`concessionSchema`, `packages/shared/src/schemas/student.ts`); the form keeps `type` and `value`
  in step so the two can never disagree.
- **It comes off the class fee lines only** — tuition and transport, not an exam fee, trip or fine.
  The rule and its reasoning are under "A concession does not apply to charges".
- **It can never make an invoice negative.** `concessionFor()` clamps to the amount owed, so a ₹5,000
  discount against ₹1,200 of fees bills ₹0 rather than a credit. There is no refund or credit-note
  concept in this system, by design.
- **Changing it does not touch invoices already issued.** Each invoice stores the discount it was
  billed with as `concessionRupees`, so the new amount applies from the next run onward.
- The invoice, the printed slip, the receipt and the WhatsApp reminder all show it as a
  **`Concession`** row, since that is the word parents see on a fee slip.
- A **percentage** concession is supported by the calculation (`concessionFor()` handles `PERCENT`,
  and a fractional percentage like 12.5% is valid) but has no field on the form. Set one with a
  `PATCH /api/v1/students/:studentId` if a percentage is ever needed; the form will report it in a
  hint and replace it with a flat amount if that field is edited.

**A charge is never negative.** Reaching for a negative amount under *Dues and other charges* is the
obvious way to try to record a discount, and it is rejected at every layer — the zod schema, the
Mongoose model and the invoice's own `min: 0` line items. Use the discount field instead.

## Operations

### Year rollover (once a year, around April)

**Year rollover** → three steps, in order. Each is safe to run again, so a half-finished rollover is
resumed by reloading the page.

1. **Copy the fee structures forward.** Amounts are copied unchanged; revise them afterwards on
   **Fee structure**.
2. **Set the new session year.** Generated student IDs and receipt numbers follow it, and the monthly
   fee run prices from it.
3. **Promote the students** — preview, then apply. Every student on the roll moves up one class;
   class 8 and anyone holding a transfer certificate become `ALUMNI`; roll numbers are cleared for
   reassignment.

**The order matters, and the screen enforces it.** Copying comes first because a clone reads its
*source* year — flip the year first and every class starts the new session unpriced. Setting the year
comes before promoting because promotion refuses to run into a session the school is not in yet. And
leaving the year flipped *without* promoting is the quiet failure the ordering exists to prevent: the
monthly run would price last year's classes against this year's structures, billing the whole school
one class behind with nothing on screen to say so.

Two guards worth knowing about. A rollover must move exactly one session forward — `2026-27` to
`2027-28`, never to itself. Promoting a year onto itself would make the selection match the rows the
update produces, so each call would advance the whole school another class and turn whatever fell off
the top into alumni, which nothing can undo. And a class code the system does not recognise is
*reported*, not graduated: `nextClassCode` returns nothing both for class 8 and for an unknown code,
and treating those alike used to turn a corrupt record into an alumnus.

Re-running step 3 is a no-op because the selection is keyed on the session being closed and the update
writes the new one. That is also the only recovery from a partial write, which is why the year pair is
validated so strictly. The promotion is recorded in `auditLogs` with the actor, the session pair and
the counts.

Rolling over does not disturb history: invoices snapshot the student's name and class
(`models/Invoice.ts`), so last year's bills still read the way they were issued.

### Monthly (fees)

1. **Generate invoices** → pick the month → *Preview* → check the totals → *Create*. Safe to re-run:
   the `studentId:period` primary key makes double-billing impossible.
2. Record payments as they come in. Print receipts from the invoice page.
3. **Fee reminders** → build a batch → work through the queue.
4. **Reports → Collection** at month end; reconcile against the bank.

### Monthly (expenses)

**Reports → Expenses** is where money going *out* is recorded — salaries, fuel, bills. Pick a month,
type a name and an amount, press Add. Each row saves immediately, so the cards above it are never
out of step with the list below.

Four figures for the chosen month: collected (with what was invoiced), total expenses, profit or
loss, and current outstanding. Under them, a running profit/loss **from the first month an expense
was ever recorded** — scoped that way because fee collection goes back to the school's first invoice
while expenses only start when someone starts typing them, and comparing the two over all time would
report a profit made entirely of the months nobody was recording.

Two things to know:

- **Outstanding is as of today**, not as of the month on screen. It is the same all-time balance the
  dashboard shows; there is no historical version of it.
- **Removing an expense deletes it.** This is the one place in the system that destroys a money
  record rather than voiding or reversing it — an expense has no receipt in a parent's hands and
  nothing points at it. The deleted name, amount and month are written to `auditLogs`, which is the
  only trace that survives.

**The month-end email.** On the last day of each month at **18:00 IST**, a scheduled function mails
that month's expenses — the table, the total, and how it sat against the month's collection — to the
same `DAILY_REPORT_TO` list as the daily collection email. It sends on a month with no expenses too,
saying so, for the same reason the daily one does: an empty inbox cannot be told apart from a dead
job.

Cron cannot express "the last day of the month", so the function is scheduled on days **28–31**
(`30 12 28-31 * *`) and returns without sending on the firings that are not month-end. That check is
what keeps February to one email and January to one rather than four, so it is covered by tests
rather than left to be noticed in production.

Anything entered after 18:00 on the last day is in the app but missed that email. **Email this
month** on the Expenses tab re-sends the selected month on demand, exactly as it stands at that
moment, to the same list — so a late entry does not mean waiting for next month. From a terminal,
`npm run report:expenses -- 2026-09` does the same thing.

That button posts to `/expenses/email`, which takes its recipients from `DAILY_REPORT_TO` and
deliberately offers no way to name them in the request: an endpoint that mailed wherever the caller
asked would be an open relay sitting behind an admin login.

If the month-end cut-off turns out to be a nuisance, moving the schedule to the 1st of the following
month (`30 12 1 * *`, reporting the previous month) closes the gap entirely.

### Daily (attendance)

Teachers mark their own classes. The dashboard flags any class not yet marked.

### Daily (fee-collection email)

The one thing in this system that runs unattended. Every day at **7:00 pm IST** a Netlify Scheduled
Function (`netlify/functions/daily-report.mjs`, schedule in `netlify.toml`) emails the day's
collection as a table — receipt, student, class, mode, amount, and a total — to whoever
`DAILY_REPORT_TO` names. Set that variable in Netlify; until it is set the job runs and deliberately
sends nothing, which is also how you switch it off.

**More than one recipient**: comma-separate them, as with `CORS_ORIGINS`. Whitespace is trimmed.

```
DAILY_REPORT_TO=office@school.in, accountant@school.in
```

Everyone named goes on **one** email and can see the others in the To header — right for an internal
report, and the reason this is not the mechanism to use for anything addressed to a parent. One send
also keeps the job to a single message against the transport's daily cap.

**It sends on a quiet day too**, saying zero. A missing email cannot be told apart from a job that
died three weeks ago, so the email arriving at all is the evidence the schedule is alive.

Two things worth knowing:

- It covers payments **dated** that day (`paidAt`), which is how the dashboard and Reports → Collection
  already count a day. Because `paidAt` is backdatable and the email goes at 7pm, a payment entered
  later — or backdated to an earlier day — appears in no digest at all. The email says so in a footer
  and points at Reports → Collection, which remains the record; `npm run report:daily -- 2026-09-04`
  re-sends any day.
- Netlify evaluates cron in **UTC** (`30 13 * * *` = 19:00 IST; India has no DST). Scheduled functions
  fire only on **published production deploys**, so a Deploy Preview cannot mail the recipient. Use
  **Run now** in the Netlify UI to fire one on demand.

Locally the schedule cannot run at all — use `npm run report:daily`. With no mail transport configured
the body is logged instead of sent, so the table can be read without credentials.

### Storage, and the 512 MB ceiling

Atlas M0 gives you **512 MB** — not 512 GB, which is an easy misreading with an expensive
conclusion. Atlas enforces it against *logical* size, so WiredTiger compression buys no headroom.
Run `npm run db:stats` to see where you actually stand; the numbers below are the shape to expect
for one school of ~250 students, and they are estimates until that script contradicts them.

Steady growth is roughly **25 MB/year**, which is about **20 years** of runway. Ranked by what
consumes it:

| Collection | Why it grows | Share |
|---|---|---|
| `attendance` | 250 students × ~250 non-Sunday school days = ~62,500 docs/yr. A roster save upserts one document per student per day, `PRESENT` included. | ~67% |
| `invoices` | 250 × 12/yr at ~1.1 KB, across nine indexes — the indexes are ~a third of it. | ~19% |
| `notifications` | Few documents, but each is a batch of ~200 embedded fee slips. | ~10% |
| `auditLogs` | ~6,500 docs/yr, then flat: the 730-day TTL is the only thing in this database that expires. | flat |
| `users` | Ten people. Rotated refresh tokens are held for 24 hours, so ~10 KB each; before that window existed it was ~120 KB each, outweighing all 250 student records. | flat |

Nothing else in this system ever shrinks: invoices are voided rather than deleted, payments are
flagged rather than removed, students are deactivated rather than deleted, and a charge is never
pulled once billed. That is deliberate — it is a financial record — but it means storage is
monotonic and worth watching once a year rather than never.

**Two things bite before storage does.** M0 has no backups (see below), and it **pauses after 30
days of inactivity** — a long holiday with no traffic can suspend the cluster, and the first request
back fails in a way that looks like a bug.

If it ever does fill, the only lever with real headroom is archiving closed academic years:
export a year's `attendance` and `invoices`, verify the counts, then delete them. Everything else
is rounding error by comparison.

### Backups

Enable backups on Atlas (M10 and above) and **do one restore drill into a scratch cluster before
go-live** — an untested backup is not a backup. For an extra offline copy:

```bash
mongodump --uri "$MONGODB_URI" --out ./backup-$(date +%F)
```

### Email (for password resets)

Required for self-service password reset and for emailed account setup. Without it the app tells users
to ask an administrator, and account creation falls back to a one-time password.

**Resend** is the transport. It needs a domain you control DNS for — its shared sender
(`onboarding@resend.dev`) delivers only to the address your Resend account was registered with and
answers `403` for anyone else, so it is for testing, not for mailing staff.

1. Add your domain at <https://resend.com/domains>, choosing a **sending subdomain** such as
   `send.yourschool.in` rather than the root. Resend recommends this, and it leaves any existing mail
   on the root domain alone.
2. Add the DNS records it shows you — an `MX` for bounce handling, a TXT SPF record, and a DKIM TXT
   record. Propagation can take up to 24 hours.
3. Create a key at <https://resend.com/api-keys>, then set:

```
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxxxxxx
MAIL_FROM="R.N. TPS Admin <noreply@yourschool.in>"
APP_BASE_URL=https://rntps-admin.netlify.app
```

The app refuses to boot in production if `MAIL_FROM` is still a `resend.dev` address, or if
`APP_BASE_URL` is localhost — both are silent failures otherwise, surfacing as a `403` or an
unreachable link on the first real reset. **`APP_BASE_URL` is not set by `netlify.toml`**; set it in
the Netlify UI.

Verify with `npm run mail:test -- you@example.com` before relying on it, and check the message reaches
`delivered` in the Resend dashboard — not merely that the script reported success.

What to expect on the free tier: 3,000 emails a month, but **100 a day**, which is the limit that
actually bites. Inviting a large staff in one sitting can hit it; invite in batches, or use the
temporary-password fallback. Logs are kept 30 days, which is what makes "did it actually send?"
answerable.

**Resend's shared sender is not a shortcut.** Without a verified domain, `MAIL_FROM` falls back to
`onboarding@resend.dev`, and Resend then answers `403` for every recipient except the exact address
the Resend account was registered with — a plus-address of that same mailbox is refused too. It is a
sender restriction, not a rate limit, so a small staff list does not avoid it. `GET /auth/config`
therefore reports reset-by-email as unavailable in that state, and the forgotten-password page keeps
pointing at an administrator, which is the truth.

**No domain? Use Brevo.** `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS` are used whenever `RESEND_API_KEY` is
unset. Brevo's free tier verifies a single sender *address* — it emails that address a confirmation
link — so there is no DNS and no domain purchase, at 300/day:

```
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_USER=xxxxxx@smtp-brevo.com  # the "Login" under SMTP & API -> SMTP, NOT your account email
SMTP_PASS=xsmtpsib-...           # the SMTP key from the same page, not your password
MAIL_FROM="R.N. TPS Admin <you@gmail.com>"   # must be the verified sender
```

Two credentials people get wrong here, both surfacing as `535 5.7.8 Authentication failed`:
`SMTP_USER` is the `xxxxxx@smtp-brevo.com` login Brevo generates, **not** the account email and not
the relay host; `SMTP_PASS` is the SMTP key (`xsmtpsib-…`), not the account password and not an API
key (`xkeysib-…`). `MAIL_FROM` is a third, separate thing: the sender address verified in Brevo.

The trade-off, stated plainly: mail leaves Brevo's IPs with a `gmail.com` From, so SPF and DKIM cannot
align with the From domain and DMARC alignment fails. `gmail.com` publishes `p=none` so mail generally
still arrives, and 10–15 staff resetting occasionally is nowhere near "bulk sender" territory — but
spam-folder risk is materially higher than with a verified domain, and a reset link in spam is a
locked-out user. Verify a domain when the school has one.

Only port 25 is blocked from a Netlify function; 465 and 587 are open, so SMTP is a real option there.
Gmail's own SMTP is the weakest choice: consumer-account mail containing a link often lands in spam,
and Google sometimes blocks programmatic sends from a data-centre IP.

### Recovering access

- **A locked-out user:** an admin clears it from **Users → Unlock**, or the user resets their own
  password.
- **A forgotten password:** the user clicks **Forgotten your password?** on the sign-in screen and gets
  a link by email. There is deliberately no reset button in **Users** — a password should only ever be
  chosen by its owner, so the admin never handles one. Failing email, use the shell script below.
- **An address nobody can receive mail at:** **Users** flags any account whose address has never been
  confirmed by a completed link, which is usually a typo. An address cannot be edited, since every
  recovery path and audit trail keys on it: deactivate the account and add the user again.
- **Role or class access is wrong:** **Users → Edit** changes a teacher's name, phone, role and
  assigned classes. Only teacher rows offer it — an admin already reaches every class, so there is
  nothing for the form to set. That makes promotion one-way from the UI: it drops the class list, and
  demoting an admin back to teacher needs a direct `PATCH /users/:userId` with a role and at least one
  class. The last active admin cannot be demoted or deactivated by either route.
- **Nobody can sign in at all:** `npm run reset:password -- someone@school.example` from a shell with
  `MONGODB_URI` set. This reactivates the account, clears any lock, revokes every session and prints a
  one-time password. It is the only path that does not require an existing session or working email,
  which is why it needs shell access.

### After a schema change

Nothing, if you are deploying: `npm run build && npm run indexes:deploy` is the Netlify build
command, and `indexes:deploy` runs `indexes:sync` for you. Run `npm run indexes:sync` by hand only
when changing indexes on a database you are not deploying to — a local `mongod`, or a cluster you
are inspecting.

Production runs with `autoIndex: false`, so indexes are never created on the fly. This used to be
documented here as a manual deploy step, and because nothing in the pipeline ran it, a cluster could
be serving traffic with **no secondary indexes at all** — every listing query a collection scan, and
the 730-day TTL on `auditLogs` never expiring anything. `npm run db:stats` tells you which is the
case: a collection holding only `_id_` when its schema declares more has never been synced.

Two things to know about the automatic run:

- **It only fires when `CONTEXT=production`.** `syncIndexes()` *drops* indexes a schema no longer
  declares, so an unguarded run would let a Deploy Preview of an unmerged branch delete an index
  from the production database.
- **It fails the deploy if it cannot reach Atlas.** That is deliberate — a deploy that silently
  loses its indexes is worse than one that stops. If you need to ship a frontend fix while the
  database is unreachable, override the build command in the Netlify UI for that one deploy, then
  run `npm run indexes:sync` once Atlas is back.

### Error reporting

Server errors are logged as JSON with a request id (`x-request-id`, echoed on every response), and
names and phone numbers are redacted. The frontend has an error boundary in
`apps/web/src/components/ErrorBoundary.tsx` — hook Sentry's `captureException` (or your own endpoint)
into its `componentDidCatch` if you want these off the user's machine. Nothing is wired to a
third-party service by default.

## Attendance: three states, and Sundays

A child was either in school or not; a holiday is not a school day at all. That is the whole model —
`PRESENT`, `ABSENT`, `HOLIDAY`. *Late* and *leave* were removed: they asked the teacher marking thirty
names each morning to make a judgement call, and nothing downstream treated them differently from
present and absent anyway.

**Sunday is a holiday for every class, with nothing to declare.** It is *derived*, never stored:

- The roster for a Sunday is read-only, everyone reads `HOLIDAY`, and `PUT /attendance/roster` returns
  400 rather than accepting marks it would then ignore.
- The monthly grid shows every Sunday as `H`, in the `holidays` map labelled `Sunday`.
- Sundays are excluded from working days, so they cannot move anyone's percentage.
- The dashboard's "not yet marked" nudge stays quiet on a Sunday.

Deriving rather than storing is what makes this safe to introduce on a live database: the rule applies
to **every past date with no backfill**, and a mark saved on a Sunday before the rule existed is
ignored rather than left to quietly drag a percentage down. `sunday.test.ts` covers that case
explicitly.

### Teachers are on the same register, in their own collection

Selecting **Teachers** instead of a class marks the teaching staff: active users with role `TEACHER`,
same three states, same Sunday and same declared-holiday calendar — both services call the same
`holidayFor` / `holidayMapFor` / totals helpers rather than each deriving the rules for itself. Only an
admin can mark it; any signed-in user can read the monthly grid, which is why that response carries a
name and nothing else about the user.

It is stored in `staffattendances`, keyed `{userId}:{dateKey}`, **not** in `attendances` with a
synthetic class code. The dashboard counts every row of `attendances` for today with no class filter,
so a shared collection would blend an absent teacher into the school's "present today" figure. Keeping
them apart makes that impossible by construction rather than by remembering a negative filter at every
present and future read site — `staffAttendance.routes.test.ts` has a test named for exactly that.

Consequently teacher attendance **deliberately does not appear** in the dashboard, the defaulter
report, the daily collection email or the WhatsApp absentee list. Those are student figures. Nor is
`TEACHERS` a member of `CLASS_CODES`: `nextClassCode` is index-based over that list, so an extra member
would promote class 8 into it at rollover instead of graduating those students to alumni.

One known limit: the roster and the grid both list *active* teachers, so a teacher who leaves mid-year
drops out of that month's grid, exactly as an INACTIVE student does. Their rows are still in the
collection; unlike a student, there is no per-person page to reach them from.

A school that opens on a particular Sunday cannot record it. If that comes up, the fix is a per-date
override in Settings' holiday list rather than loosening the rule.

Any `LATE` or `LEAVE` records left in the database are converted by
`npm run migrate:rupees --workspace @rntps/api` — LATE to PRESENT (the child was in school), LEAVE to
ABSENT (they were not). Records left on a retired value would simply stop being counted, which is
worse than converting them.


## Dues and other charges

**A student has at most one invoice per month, and it carries everything they owe for that
month** — class fees, transport, and any charges specific to them.

Charges are therefore *not* invoices. They sit on the student's record and wait:

```
Student page → Fees → Dues and other charges → Add a charge
   "What is it for"  +  "Amount"     →  waits on the student

Next monthly invoice run
   Tuition ₹500  +  Transport ₹700  +  Dues carried forward ₹3,000  +  Exam fee ₹450
   = one invoice, ₹4,650
```

Use them for arrears from before this system, an exam fee, a trip, a breakage, a fine.
`POST /students/:studentId/charges` with `{ name, amountRupees }`; `GET` to list;
`DELETE /students/:studentId/charges/:chargeId` to drop one that has not been billed yet.

### A charge is billed exactly once

A charge counts as billed **precisely when some non-void invoice carries its id** in a line item.
That is the only record — there is no separate "billed" flag to fall out of step with reality, and if
a run dies halfway through, re-running it sees the charge as billed and will not bill it twice.

Three consequences fall out of that, all tested:

- A charge added **after** the month's invoice exists is picked up by the **next** month's run. The
  existing invoice is never rewritten.
- **Voiding an invoice frees its charges again**, because a voided invoice bills nothing. They return
  to pending and the next run takes them.
- A charge that has been billed **cannot be removed** — it is a line on an invoice a parent may
  already have paid against. Void or adjust the invoice instead.

### The student page shows all three states

Transport and the discount each show a row even when there is nothing to bill — "Not opted",
"None". A hidden row is indistinguishable from one that has not loaded, and whether a child rides
the bus or holds a discount is exactly what this section exists to answer.

| Group | What it is |
|---|---|
| **Every month** | Recurring extras from the fee structure — transport — and the student's standing discount, shown green as a `−` amount. Already inside each monthly invoice, so not added to the outstanding total |
| **Waiting for the next invoice** | Charges entered but not yet billed, with a running total, each removable |
| **Already billed** | Charges a monthly invoice absorbed, linked to that invoice |

The invoice-run preview shows what it is about to absorb, per row (`+2 charges ₹3,450`) and as a
banner totalling the run.

### Charges with no fee structure still get billed

A student whose class has no fee structure normally sits out the run. If they carry pending charges,
an invoice is raised for those alone — otherwise real money owed would sit unbilled until somebody
remembered to configure the class. The class is still reported under `classesWithoutStructure`.

### A concession does not apply to charges

It comes off the class fee lines only — tuition and transport. A trip or a fine is not the school's
fee to discount, and arrears are already net of whatever concession applied when they arose.

```
Tuition ₹1,000 + Picnic ₹300, student has a 50% concession
   gross ₹1,300  −  concession ₹500 (half of ₹1,000)  =  ₹800
```

### Legacy note

Charges used to be raised as their own invoices, keyed `{studentId}:{period}:C0001`. Any of those
already in the database stay exactly as they are — real debts, payable, and brought forward on the fee
slip. Nothing new is created in that shape.


## The fee slip

A **receipt** proves what was paid. A **fee slip** says what to pay — and a parent with arrears needs
one number, not two bills. Invoice page → **Fee slip**, or `GET /fees/invoices/:invoiceId/slip`.

```
            R N TAGORE PUBLIC SCHOOL
                    FEE SLIP
  ----------------------------------------------
  Ankur Raj · Class 4 · RNTPS-26-001
  Fee month 2026-08   Due 2026-08-10
  ----------------------------------------------
  BROUGHT FORWARD
    Dues carried forward      2026-03   ₹4,000
    Previous dues                       ₹4,000
  ----------------------------------------------
  2026-08 CHARGES
    Tuition Fee                           ₹500
    Transport fee                         ₹700
    This month                          ₹1,200
  ==============================================
  TOTAL PAYABLE                         ₹5,200
```

**The invoice still charges only its own month.** Everything under *Brought forward* is read from
those older invoices and displayed; it is never copied onto this one. That is the whole design
constraint — the original bills still stand, so charging them again here would double the school's
reported receivables. `feeSlip.test.ts` asserts exactly that: a slip showing ₹5,200 sits alongside a
dues report that also totals ₹5,200, not ₹9,200.

Older bills are listed oldest first and named, so *Exam fee* and *Dues carried forward* are
distinguishable. Settled, voided and zero-balance invoices drop off entirely, and a voided invoice
owes nothing itself while still showing what is outstanding elsewhere.


## The WhatsApp fee demand

The same numbers as the fee slip, laid out for a phone. **Fee reminders** → build a batch → work
through the queue; each item opens a `wa.me` chat with the message pre-filled.

````
*R N Tagore Public School*
Sahijana Road · Garhwa

*MONTHLY FEE · August 2026*
```
Name: Aarav Sharma
Std.: 4
--------------------------
Tuition Fee        ₹ 1,000
Transport fee        ₹ 700
Exam fee             ₹ 100
Concession          -₹ 170
Previous dues      ₹ 4,000
Less paid           -₹ 500
==========================
Total payable      ₹ 5,130
```
_Fee should be paid from 1st to 10th of every month._
````

**Only the table is fenced.** WhatsApp renders a `` ``` `` block in monospace, which is what makes the
amount column line up; a whole message in monospace reads small and cramped, so the school name, the
month and the note stay as normal text. The rules are ASCII `-` and `=` rather than box drawing,
because every `─` costs nine characters once percent-encoded into the URL.

**Every row that is not ₹0 is shown, and no row that is.** A student who does not use the bus has no
transport line at all rather than a `₹ 0` one. `Concession` and `Less paid` are not decoration —
`lineItems` sum to *gross*, so without them the rows would not add up to the figure the parent is
asked to pay. `feeMessage.test.ts` asserts that property directly: read the column down, and it
totals the last row.

**Previous dues is one row, and display only.** It is the same rule as the fee slip — those older
invoices still stand, so re-charging them here would double the school's receivables. The consequence
worth knowing: filtering a batch to August still counts July's unpaid bill, because a parent handed a
figure that ignores it would pay the wrong amount. The filter decides *who* to chase; the amount then
covers everything they owe.

### Siblings get one message, itemised per child

A block each, a subtotal each, then a family total. The month is named only when every child's
itemised bill is for that same month — a filter can select July while the newest unpaid bill is
August — and otherwise the header reads *Outstanding fees*.

````
```
Aarav Sharma · Std. 4
Tuition Fee        ₹ 1,000
Previous dues      ₹ 4,000
  Subtotal         ₹ 5,000
--------------------------
Ananya Sharma · Std. 1
Tuition Fee          ₹ 400
  Subtotal           ₹ 400
==========================
FAMILY TOTAL       ₹ 5,400
```
````

A `wa.me` URL is capped rather than the message: encoding is nowhere near length-preserving — one `₹`
becomes nine characters — so the character count says little about the thing that actually gets
truncated. A two-child message is around 800 characters of URL against a 4,000 ceiling, so the
fallback below is rare in practice. If a family does overflow it, the slip re-renders compact (one
line per child, no breakdown), and only then is it trimmed by whole lines — with the fence re-closed,
because an unclosed `` ``` `` makes WhatsApp render the rest of the conversation as code.

**Wording lives under the settings key `FEE_DEMAND`**, which supersedes `FEE_DUE`. A new key rather
than a new body under the old one: `seedSettings` leaves an existing settings document untouched and
there is no template editor in the UI, so a deployment already holding a `FEE_DUE` row would have been
pinned to the old flat summary for ever. The new key misses that row and falls through to the shipped
default, so the format lands with no migration. Any existing `FEE_DUE` row is left alone and no longer
read. Placeholders: `{{schoolName}}`, `{{schoolAddress}}`, `{{periodLabel}}`, `{{slip}}`, `{{note}}` —
where `{{slip}}` is the fenced table and `{{note}}` is derived from `feeDueDayOfMonth`, so the
payment window can never drift from the invoice due date.


## How a monthly invoice is calculated

In order, per student:

1. **Read the student record** — `classCode`, `transportOpted`, `transportFareOverrideRupees`, `concession`
2. **Load that class's fee structure** for the academic year (no structure → the class is reported as unbillable, nothing is billed)
3. **Keep the heads that apply** — `appliesTo: 'ALL'` always; `appliesTo: 'TRANSPORT_OPTED'` only if the student opted into transport at onboarding
4. **Resolve transport** — the student's own fare wins over the class amount, and is billed **even if the class has no transport head at all**
5. **Append any pending charges** from the student's record, each carrying its charge id
6. **Sum to gross, then subtract the concession** — which applies to the fee lines only, not to charges

```
Class 4 structure     Tuition ₹500 [ALL] · Transport ₹500 [TRANSPORT_OPTED]

transportOpted=false                    → Tuition ₹500                    = ₹500
transportOpted=true,  no fare set       → Tuition ₹500 + Transport ₹500    = ₹1,000
transportOpted=true,  fare ₹700         → Tuition ₹500 + Transport ₹700    = ₹1,200
transportOpted=true,  fare ₹0           → Tuition ₹500 + Transport ₹0      = ₹500   (travels free)
transportOpted=false, fare ₹700         → Tuition ₹500  (fare flagged, not billed)

Class 1 structure      Tuition ₹400 [ALL]   — no transport head at all

transportOpted=true,  fare ₹350         → Tuition ₹400 + Transport ₹350    = ₹750
transportOpted=true,  no fare set       → Tuition ₹400  (flagged transportUnpriced)

+ 20% concession on the ₹1,200 case      → gross ₹1,200 − ₹240             = ₹960
```

**The student record is the authority on transport, not the fee structure.** Ticking "Uses school
transport" at onboarding is the whole mechanism. A transport head in the class structure is only a
*default amount* — it is **not** a prerequisite for billing. A student who opted in and carries their
own fare is billed that fare even when their class has no transport head, under the code `TRANSPORT`
and the label "Transport fee".

That matters because the old rule silently under-billed: a child clearly signed up for the bus, with a
fare on their record, was charged nothing for it because nobody had added a transport head to their
class. Nothing in the UI said so.

Two situations are reported rather than passed over, per row and as a banner on the invoice-run preview:

| Flag | Meaning | Fix |
|---|---|---|
| `transportUnpriced` | Uses transport, but no fare on the student *and* no transport head on the class — there is no amount to charge | Set a fare on the student, or add a transport head to the class |
| `transportFareIgnored` | A fare is on record but transport is switched off, so it is not billed | Usually a leftover after the service was cancelled; clear the fare or switch transport back on |

The only case that cannot be billed is `transportUnpriced` — nothing anywhere names a price. Note that
a fare of **₹0** is a real amount (a child who travels free), not an absent one.

Charges from the student's record are appended as further line items, so the result is a single
invoice covering everything owed for that month. See the section above.

`calculationChain.test.ts` pins every line of the table above, and asserts the committed invoice
matches the preview exactly.


## Data protection

This system stores children's personal data, so India's DPDP Act 2023 applies: collect the minimum,
record guardian consent at admission, share with no third party, and define a retention policy. Logs
are configured to redact names and phone numbers — records are identified by `studentId` only.
Every mutation to students and users is recorded in `auditLogs` (secrets scrubbed, two-year TTL).
