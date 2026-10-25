# Brown Mule PayU checkout

The `MULE@5` code gives 5% off the coffee and shipping total on the first **paid** order for the 10-digit Indian mobile number entered at checkout. Login method and account email are not part of eligibility. The browser displays a quote, but the backend recalculates catalog prices, checks the phone, reserves the code, and signs that final amount for PayU.

## Production setup

Set `DATABASE_URL` to a persistent PostgreSQL database on the PayU web service. Neon's Free plan is one no-cost option; use its pooled connection string with `sslmode=require`. The service creates `bm_payu_checkouts` and `bm_payu_coupon_claims` on first use. Keep the existing `PAYU_KEY`, `PAYU_SALT`, `PAYU_ENV`, `BROWN_MULE_STORE_URL`, and notification settings. The backend accepts regular checkout without a database, but disables `MULE@5` until persistent storage is configured. A free Render Postgres instance expires after 30 days, so it is unsuitable for live redemption history.

If the store already has paid orders, import their normalized checkout mobile numbers before enabling the code. The user confirmed there are currently no past paid orders, so no backfill is needed for this launch.

Use `BROWN_MULE_LOCAL_STORE=1` only for local preview and tests; it writes `.brown-mule-first-orders.json` in the current directory. The production service should leave it unset. `npm test` exercises the signed PayU amount, email independence, duplicate checkouts, callback tampering, and failed-payment retry without a real payment.
