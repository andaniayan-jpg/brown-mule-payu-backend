# Brown Mule PayU checkout

The `MULE@5` code gives 5% off the coffee and shipping total on the first **paid** order for the 10-digit Indian mobile number entered at checkout. Login method and account email are not part of eligibility. The browser displays a quote, but the backend recalculates catalog prices, checks the phone, reserves the code, and signs that final amount for PayU.

## Production setup

Set `DATABASE_URL` to a durable PostgreSQL database on the PayU web service. The service creates `bm_payu_checkouts` and `bm_payu_coupon_claims` on first use. Keep the existing `PAYU_KEY`, `PAYU_SALT`, `PAYU_ENV`, `BROWN_MULE_STORE_URL`, and notification settings. The backend accepts regular checkout without a database, but disables `MULE@5` until durable storage is configured. A free Render Postgres instance expires after 30 days, so it is unsuitable for production redemption history.

**Import existing paid orders before enabling the code.** The new database cannot infer historical purchases from account email or the web service's ephemeral `.brown-mule-orders.json`. For each previous paid order, import its normalized checkout mobile number into `bm_payu_checkouts` with a unique `txnid`, the actual amount, `status = 'success'`, and an `order_data` JSON object. Exclude failed and cancelled payments. This prevents previous buyers from receiving a new first-order discount.

Use `BROWN_MULE_LOCAL_STORE=1` only for local preview and tests; it writes `.brown-mule-first-orders.json` in the current directory. The production service should leave it unset. `npm test` exercises the signed PayU amount, email independence, duplicate checkouts, callback tampering, and failed-payment retry without a real payment.
