# Brown Mule PayU checkout

The `MULE@5` code gives 5% off the coffee and shipping total on the first **paid** order for the 10-digit Indian mobile number entered at checkout. Login method and account email are not part of eligibility. The browser displays a quote, but the backend recalculates catalog prices, checks the phone, reserves the code, and signs that final amount for PayU.

After PayU returns a verified success, the backend creates a paid Shopify Admin order when `SHOPIFY_STORE_DOMAIN` plus either the current Dev Dashboard credentials (`SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET`) or a legacy `SHOPIFY_ADMIN_ACCESS_TOKEN` are configured. The Shopify order includes the customer details, delivery address, coffee lines and grind sizes, paid amount, PayU transaction ID, and coupon details. Repeated callbacks are checked against the transaction note to prevent duplicate Shopify orders. Dev Dashboard credentials are exchanged for and cached as a short-lived Shopify token automatically.

The custom app needs `read_orders` and `write_orders` access. `read_orders` lets the backend check for a duplicate PayU transaction before creating an order.

## Customer order confirmations

After a verified PayU success, Shopify sends its itemized order-confirmation email to the checkout email address when the order is created. If Shopify order creation fails, the backend can send a customer email through Resend when configured. A WhatsApp template message goes to the checkout mobile number only when the customer checks the Brown Mule WhatsApp consent box at checkout. The existing admin order email remains separate. A failed WhatsApp delivery status triggers one SMS fallback for that transaction. A WhatsApp API rejection also triggers the fallback immediately. A message accepted by Meta is not proof of delivery; configure the signed webhook below so an undeliverable number can be detected. Notifications are sent only on the first verified success callback; an old paid order is not messaged retroactively.

Shopify's own order confirmation email needs no extra email service; ensure the store's notification template is enabled. The optional email fallback and admin email need `RESEND_API_KEY` and `ORDER_EMAIL_FROM` (a verified sending domain). WhatsApp needs `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, and `WHATSAPP_WEBHOOK_VERIFY_TOKEN`. Set the Meta callback URL to `https://brown-mule-payu-backend-6.onrender.com/api/whatsapp/webhook` and subscribe to message status updates. The webhook verifies Meta's signature before it processes failures.

For the itemized WhatsApp version, approve a utility template in WhatsApp Manager with four body variables in this order: customer name, Shopify order number, item summary, paid total. Set `WHATSAPP_TEMPLATE_NAME` to that approved template and `WHATSAPP_TEMPLATE_STYLE=itemized`. Until then, the existing `brown_mule_order_confirmation` template keeps its original four variables: name, PayU transaction, amount, address.

SMS fallback needs a provider account and approved sender: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, plus either `TWILIO_MESSAGING_SERVICE_SID` or `TWILIO_SMS_FROM`. For Indian numbers, arrange the required sender and message template registration with the provider before enabling SMS. Without these values, the backend logs that SMS was unavailable and does not attempt to charge or send anything. WhatsApp delivery failures can have causes besides an unregistered WhatsApp number, so SMS is used for any confirmed failed WhatsApp status.

## Production setup

Set `DATABASE_URL` to a persistent PostgreSQL database on the PayU web service. Neon's Free plan is one no-cost option. Use a database owned by the application role so that role can create `bm_payu_checkouts` and `bm_payu_coupon_claims` on first use. The direct Neon connection string with `sslmode=verify-full` works for this single-instance service; a pooled connection can be used after the tables exist. Keep the existing `PAYU_KEY`, `PAYU_SALT`, `PAYU_ENV`, `BROWN_MULE_STORE_URL`, and notification settings. The backend accepts regular checkout without a database, but disables `MULE@5` until persistent storage is configured. A free Render Postgres instance expires after 30 days, so it is unsuitable for live redemption history.

If the store already has paid orders, import their normalized checkout mobile numbers before enabling the code. The user confirmed there are currently no past paid orders, so no backfill is needed for this launch.

Use `BROWN_MULE_LOCAL_STORE=1` only for local preview and tests; it writes `.brown-mule-first-orders.json` in the current directory. The production service should leave it unset. `npm test` exercises the signed PayU amount, email independence, duplicate checkouts, callback tampering, and failed-payment retry without a real payment.
