# Brown Mule post-payment notifications

The backend sends notifications only after it receives a PayU `success` callback with a valid response hash. A notification error never changes the paid order result or the redirect back to the cart.

## Email to Brown Mule

Use a transactional email provider such as Resend, verify a sender/domain there, then add these Render environment variables:

```text
RESEND_API_KEY=re_...
ORDER_EMAIL_FROM=Brown Mule Orders <orders@your-verified-domain.com>
ORDER_EMAIL_TO=brownmule01@gmail.com
```

The recipient defaults to `brownmule01@gmail.com`. The email contains the paid order number, name, email, mobile number, delivery address, items, and paid total.

## WhatsApp confirmation to the customer

Use a Meta WhatsApp Business Account and create an approved utility template named `brown_mule_order_confirmation` with four body variables:

```text
Hello {{1}},

Your Brown Mule order {{2}} has been confirmed. Amount paid: {{3}}.

We will deliver it to:
{{4}}

Thank you for choosing Brown Mule.
```

Then add these Render environment variables:

```text
WHATSAPP_ACCESS_TOKEN=<permanent-or-system-user-token>
WHATSAPP_PHONE_NUMBER_ID=<Meta-phone-number-id>
WHATSAPP_TEMPLATE_NAME=brown_mule_order_confirmation
WHATSAPP_TEMPLATE_LANGUAGE=en_US
WHATSAPP_GRAPH_API_VERSION=v22.0
```

The checkout form requires a valid 10-digit Indian mobile number and automatically sends it to the WhatsApp Cloud API as `91` plus that number.
