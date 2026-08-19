# Going live at infinity.genomicslab.in

The platform is finished and running on the live stack, but the public hostname
`infinity.genomicslab.in` still points at the **marketing splash**, not the app.
This is the deliberate holding state. Cutover is the set of steps below, done
together on go-live day.

Nothing here is urgent or half-done: because the public host serves the splash,
no client can reach the platform — so the live stack can sit ready indefinitely
without exposing anything.

## Current state (verified)

- Live stack (`docker compose -p infinity`) runs current code. API, web, render,
  splash all up.
- `api/.env.live` holds the production CCAvenue triple registered for
  `infinity.genomicslab.in`, with `PublicBaseUrl=https://infinity.genomicslab.in`.
- **Gateway is deliberately on `test.ccavenue.com`** — armed to `secure` only at
  cutover, so a production gateway is never live behind the splash.
- Origin routing is correct: direct to the web container, `POST /api/payments/callback`
  → 302, `GET /api/payments/config` (unauth) → 401. The **only** thing between
  the app and the public is the tunnel pointing at splash (3120) instead of
  web (3121).

## Cutover steps

1. **Repoint the cloudflared tunnel** (host config, not in this repo) so
   `infinity.genomicslab.in` → `127.0.0.1:3121` (web), not `:3120` (splash).
   Relocate the marketing splash to its own hostname first if it is to be kept.
   The compose header warns "do not repoint casually" — this is the considered
   occasion.

2. **Arm the production gateway.** In `api/.env.live`:
   ```
   CCAvenue__GatewayUrl=https://secure.ccavenue.com/transaction/transaction.do?command=initiateTransaction
   ```
   then `docker compose -p infinity -f docker-compose.yml up -d api`. Confirm the
   log reads `ccavenue.mode enabled=True test=False redirect=https://infinity.genomicslab.in/...`.

3. **Verify the public edge** now reaches the app, not the splash:
   ```
   curl -sk -o /dev/null -w "%{http_code}\n" -X POST https://infinity.genomicslab.in/api/payments/callback -d "encResp=zzzz"
   ```
   Expect **302** (was 405 while behind the splash). And
   `GET /api/payments/config` unauth → **401** (was 200 text/html from the splash).

4. **One real end-to-end payment**, small amount, on a client where a credit is
   acceptable. Confirm: lands on `/payment/complete?pay=success`, the receipt PDF
   downloads, the ledger shows it as `online`, and exactly one credit row appears.
   This is the only check that exercises the live working key against the live
   gateway — the per-URL credentials cannot be proven any other way.

5. **The adversarial probe** against live, to prove the callback still refuses a
   forged amount once real money is flowing:
   `scratchpad/p1verify/33_ccavenue.mjs` with `TARGET=https://infinity.genomicslab.in`
   and `ENV_FILE=api/.env.live`.

## If cutover is aborted

Flip `CCAvenue__GatewayUrl` back to `test.ccavenue.com`, `up -d api`, and repoint
the tunnel back to splash (3120). The stack returns to the holding state with no
residue.
