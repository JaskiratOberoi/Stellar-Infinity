# Infinity API

ASP.NET Core 9 minimal API — Infinity's data layer over **Noble**, the shared LIS
MS SQL Server database.

> **Noble is the live LIS production database.** It is the system of record for
> patients, samples, tests, bills and results, and it is shared with the legacy
> LIS that labs are using right now. Reads are cheap; writes and schema changes
> are production migrations and need explicit sign-off.

## Layout

```
api/
  src/Infinity.Api/
    Program.cs                     host wiring, DI, startup validation
    Data/
      NobleOptions.cs              connection settings + connection-string builder
      NobleConnectionFactory.cs    THE only place a connection is opened; timing/tracing
      SqlRetry.cs                  transient-failure classification + backoff
    Domain/
      NobleTime.cs                 IST wall-clock handling for Noble datetimes
      Origin.cs                    the `inf:<userId>` origin marker
    Reads/
      SampleHeader.cs              read model
      SampleHeaderRepository.cs    first read module
    Endpoints/
      ApiEndpoints.cs              /health, /api/samples/{sid}/header
  Dockerfile
  .env.example
```

## Run it

```bash
cp api/.env.example api/.env   # then fill in Noble__Server / Noble__User / Noble__Password
```

```bash
docker build -t infinity-api:dev api && docker run --rm -p 127.0.0.1:8099:8080 --env-file api/.env infinity-api:dev
```

Then `GET http://127.0.0.1:8099/health` and
`GET http://127.0.0.1:8099/api/samples/<SID>/header`.

Building on the host needs the .NET 9 SDK, which is **not** installed on this
machine — only the runtime stub. The Docker path above needs nothing extra.

## Conventions that are not optional

**One connection entrypoint.** Everything goes through
`NobleConnectionFactory`. Microsoft.Data.SqlClient pools internally, keyed on the
exact connection string, so the string is built once and cached — recomposing it
per request silently creates a second pool and doubles the connection count
against a database the live LIS is also using. `Noble__MaxPoolSize` (default 20)
is the hard cap; hundreds of concurrent API users must be absorbed by cache, not
turned into hundreds of SQL connections.

**Retry only what is provably safe.** `SqlRetry` matches a curated set of error
numbers plus severity class >= 20, and nothing else. Telo's original version
retried anything whose message contained "failed", which replayed
non-idempotent writes. `ExecuteAsync` is safe for reads and for writes that fail
atomically before commit — do not wrap a multi-step write that can partially
commit.

Two things worth knowing, both found by testing rather than reading docs:

- On Linux, a TCP-level connection failure arrives as `SqlException` with
  `Number = 0` and only `Class = 20`. Matching on error numbers alone never
  retries a network blip, which is why the class check exists.
- `InvariantGlobalization=true` looks like free image savings but makes
  Microsoft.Data.SqlClient throw `Globalization Invariant Mode is not supported`
  on every `Open()`. The csproj pins it to `false` with a comment.

**Datetimes.** Noble stores IST wall-clock with no timezone. The driver returns
`DateTimeKind.Unspecified` and does not convert — which is correct. Never call
`ToUniversalTime()`/`ToLocalTime()` on a value read from Noble; run it through
`NobleTime.ToIst()` to attach +05:30 and serialize the `DateTimeOffset`.
Infinity deliberately emits a real offset rather than Telo's "IST wall-clock
stamped Z" convention, which only works because Telo's frontend knows to undo it.

**The origin marker.** Every row Infinity creates in a shared LIS table must be
stamped `inf:<userId>` (`Origin.For`), and every write procedure must refuse to
mutate a row failing `Origin.IsOurs`. Telo uses `telo:<userId>` for the same
purpose — do not reuse its prefix, or the two systems become indistinguishable
and each can corrupt the other's records. Index any column filtered with
`LIKE 'inf:%'`.

## Auth

Users sign in with their **LIS credentials**. `dbo.usp_inf_authenticate` gates
three populations differently, which is what lets Infinity coexist with both the
legacy LIS and Telo:

| Population | Detected by | Login gate |
|---|---|---|
| Infinity-managed | `inf_account` row | `inf_account.inf_active` |
| Telo-managed | `telo_account` row | `telo_account.telo_active` |
| Native LIS | neither | `tbl_med_user_master.IsActive` |

So every existing LIS user can sign in to Infinity on day one with no migration,
and a user disabled in Telo is denied here too.

**The LIS access switch.** An Infinity-created account gets `IsActive = 0` and
`lis_access = 0`, so the legacy LIS rejects it while Infinity admits it. The
admin panel calls `usp_inf_admin_set_lis_access`, which flips `lis_access` and
re-derives `IsActive = (inf_active AND lis_access)` — the only bit the LIS reads.
That is how an Infinity credential starts (or stops) working on the LIS.

> **Shared-column hazard.** Telo derives that *same* `IsActive` column from its
> own flag pair. Two systems writing one derived column clobber each other, so
> every Infinity admin procedure refuses to touch an account that has a
> `telo_account` row, and the user list exposes `managed_by` so the UI can show
> why. One account, one managing system.

Roles come from `inf_user_role` if assigned, otherwise are derived in code from
the LIS usertypeid (`Auth/InfinityRoles.cs`) — unknown types fall back to
`viewer`. **The role list is duplicated in SQL** (procedures 20 and 23); adding a
role in code without deploying those makes users of that role unsavable, a bug
Telo actually shipped.

Capabilities are baked into the JWT so authorization costs no database hit.
`inf_user_session_version` makes that safe: every admin procedure bumps it, and
each request compares the token's `sv` claim against the current value, so a
demotion or password reset kills outstanding tokens. That check **fails open** on
a database error — an outage must not sign out every lab in the country.

Verified by test: forged signature → 401, valid token lacking the capability →
403, rate limiter cuts login off after 8 attempts per username+IP per 15 min.

## The worksheet

Result entry, authorisation and the amendment trail. `Worksheet/` on the API
side, `usp_inf_worksheet_sample` / `usp_inf_result_save` /
`usp_inf_result_reopen` in SQL.

Three things are deliberately different from the legacy LIS, and each one is a
defect it actually has (see `docs/worksheet-lis-analysis.md`):

**The audit records values, not events.** `inf_result_audit` holds one row per
FIELD change with both the old and the new value, written inside the same
transaction as the change itself. Placing it in the procedure rather than in C#
matters: an audit written after the update can be lost to a crash between the
two, leaving a changed clinical result with no record of the change.

**Permissions are enforced on the write, not on the control.** The caller's
rights arrive at `usp_inf_result_save` as explicit flags and a violation aborts
the whole batch. The legacy checks permissions only to enable or disable a
checkbox — and because a disabled ASP.NET `CheckBox` posts back as *unchecked*,
a user without the authorise right silently **cleared** existing authorisations
by pressing Save.

**Amending and reopening are separate capabilities.** `result:amend` requires a
reason of real length; `result:reopen` is needed before an authorised sample can
be touched at all and stops at Admin. In the legacy system, re-opening a signed
report needed nothing but any non-empty string, from any user who could see the
worksheet.

### Auto-authorisation

Off by default, per test / profile / department, and enabling it needs **two**
independent things: the `autoauth:manage` capability and a separate unlock
password. Only in-range numeric results are ever signed automatically —
narratives, coded results and out-of-range values never are.

The password is stored as a salted PBKDF2-HMAC-SHA256 digest
(`AutoAuth__UnlockHash`), verified in constant time. Rotate it with:

```bash
dotnet run --project api/tools/HashPassword -- '<new password>'
```

Set the result as an environment variable so the change is config, not a commit.
`AutoAuth__Enabled=false` refuses every rule change regardless of password.

Every automatic authorisation is written as action `auto_authorize` with source
`auto`, so "which results reached a patient without a human reading them" is a
one-line query. The legacy equivalent — the worksheet's "Check" button — signs
every in-range result and writes a row indistinguishable from a pathologist's.

### Two SET-option traps, both found by running the scripts

`QUOTED_IDENTIFIER` is captured at CREATE time and baked into the object, not
taken from the caller. A filtered index and a `MERGE` both refuse to run without
it. Microsoft.Data.SqlClient connects with it ON, sqlcmd does not — so a script
that deploys fine through `DeploySql` fails when a DBA runs it by hand, and a
procedure created that way fails on **every** call thereafter. The affected
scripts set it explicitly.

## Not built yet

- **MCC scope** — which client codes a user may see. Until this lands, any
  authenticated user can read any SID, so do not expose the API to client
  accounts yet. It belongs as an endpoint filter next to `RequireCapability`.
- Redis (the session-version cache and login rate limiter are in-process, so
  both break correctness the moment a second instance exists).
- `usp_inf_*` write procedures and their TVP types.
- The report pipeline — QuestPDF rather than Telo's Chromium renderer.

## Deploying the SQL

`api/db/sql/*.sql` is applied in lexical order; `00_schema_guard.sql` asserts its
dependencies and fails loudly if Telo is not present. Everything is idempotent —
tables are `IF NOT EXISTS`, procedures are `CREATE OR ALTER`.

**These have not been deployed.** They target the live production Noble server
shared with the running LIS, so applying them is a production migration and
needs explicit sign-off.

## Session security

The JWT is delivered as an **httpOnly cookie**, not in the response body. Script
cannot read it, so an XSS defect can no longer lift a credential and replay it
from elsewhere — the attacker is confined to acting through the open page.
`/api/auth/login` returns only the expiry and the user.

Cookies ride along on cross-site requests, so that protection is paid for with
CSRF exposure, and `Auth/CsrfProtection.cs` closes it: login also sets a
readable random token which the SPA echoes in `X-CSRF-Token`. A cross-origin
page can make the browser *send* our cookies but cannot *read* them, so it
cannot produce the header. Exempt: safe methods, `/api/auth/login`, and any
request carrying an explicit `Authorization` header — which is what keeps
instrument drivers, curl and scripts working unchanged.

**`AuthCookie__Secure` is currently `false`**, set in `docker-compose.yml`. This
is a deliberate concession to the stack serving plain HTTP on `127.0.0.1:3121`:
browsers silently discard a `Secure` cookie on an insecure origin, which would
break sign-in outright rather than degrade it. The API logs
`authcookie.insecure` at every startup while it is off. **Set it to `true` the
moment TLS terminates in front of the SPA.**

Three further rules live in the SPA (`web/src/auth/sessionGuard.ts`):

* **Closing the last tab signs out.** Tabs register in a heartbeat registry, so
  a crashed tab goes stale rather than making the session immortal. A reload is
  indistinguishable from a close at the moment it happens, so the close is
  timestamped and judged at the next startup — a tab returning within five
  seconds was a refresh. The deliberate gap: `Ctrl+Shift+T` within that window
  resumes the session.
* **45 minutes idle signs out**, counted across every tab, with a two-minute
  warning so a half-typed worksheet is not lost silently.
* **Jarvis unlock is remembered server-side** for the session, keyed to user and
  session version, so a refresh does not re-prompt and revoking a session drops
  the grant.
