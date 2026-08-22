import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const PAYU_PAYMENT_URLS = {
  production: 'https://secure.payu.in/_payment',
  test: 'https://test.payu.in/_payment',
}

const PRODUCT_CATALOG = {
  arabica: { name: 'Arabica Whole Bean', price: 650 },
  'arabica-ground': { name: 'Arabica Ground Coffee', price: 650 },
  robusta: { name: 'Robusta Whole Bean', price: 500 },
  'robusta-ground': { name: 'Robusta Ground Coffee', price: 500 },
}

const SHIPPING_INCLUSIVE_OF_GST = 120
const MULE_DISCOUNT_CODE = 'MULE@5'

const ORDER_STORE = path.resolve(process.cwd(), '.brown-mule-orders.json')

let envLoaded = false

function loadLocalEnv() {
  if (envLoaded) {
    return
  }

  envLoaded = true

  for (const fileName of ['.env.local', '.env']) {
    const filePath = path.resolve(process.cwd(), fileName)

    try {
      const content = readFileSync(filePath, 'utf8')

      content.split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim()

        if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) {
          return
        }

        const [rawKey, ...rawValue] = trimmed.split('=')
        const key = rawKey.trim()

        if (!key || process.env[key]) {
          return
        }

        process.env[key] = rawValue.join('=').trim().replace(/^['"]|['"]$/g, '')
      })
    } catch {
      // Optional local env file.
    }
  }
}

function sha512(value) {
  return crypto.createHash('sha512').update(value).digest('hex')
}

function getPayuConfig() {
  loadLocalEnv()

  const key = process.env.PAYU_KEY
  const salt = process.env.PAYU_SALT
  const clientId = process.env.PAYU_CLIENT_ID || ''
  const clientSecret = process.env.PAYU_CLIENT_SECRET || ''
  const env = process.env.PAYU_ENV === 'production' ? 'production' : 'test'

  if (!key || !salt) {
    throw new Error('PayU is not configured. Add PAYU_KEY and PAYU_SALT to .env.local.')
  }

  return {
    key,
    salt,
    clientId,
    clientSecret,
    env,
    paymentUrl: PAYU_PAYMENT_URLS[env],
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''

    req.on('data', (chunk) => {
      body += chunk

      if (body.length > 1_000_000) {
        reject(new Error('Request body is too large.'))
        req.destroy()
      }
    })

    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch {
        reject(new Error('Invalid JSON body.'))
      }
    })

    req.on('error', reject)
  })
}

function parseFormBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''

    req.on('data', (chunk) => {
      body += chunk

      if (body.length > 1_000_000) {
        reject(new Error('Request body is too large.'))
        req.destroy()
      }
    })

    req.on('end', () => {
      const params = new URLSearchParams(body)
      resolve(Object.fromEntries(params.entries()))
    })

    req.on('error', reject)
  })
}

async function parseCheckoutPayload(req) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase()

  if (contentType.includes('application/json')) {
    const payload = await parseJsonBody(req)
    const customer = payload.customer || {}
    return {
      items: payload.items,
      couponCode: payload.couponApplied || payload.couponCode || '',
      customer: {
        name: customer.name || payload.customerName || payload.name || '',
        email: customer.email || payload.customerEmail || payload.email || '',
      },
      deliveryAddress: payload.deliveryAddress || payload.address || payload,
    }
  }

  const form = await parseFormBody(req)
  let items = []

  if (typeof form.items === 'string' && form.items.trim()) {
    try {
      items = JSON.parse(form.items)
    } catch {
      throw new Error('Invalid cart payload.')
    }
  }

  return {
    items,
    couponCode: form.couponApplied || form.couponCode || '',
    customer: {
      name: form.customerName || form.name || '',
      email: form.customerEmail || form.email || '',
    },
    deliveryAddress: {
      addressLine1: form.addressLine1 || form.shippingAddressLine1 || '',
      addressLine2: form.addressLine2 || form.shippingAddressLine2 || '',
      addressLine3: form.addressLine3 || form.shippingAddressLine3 || '',
      locationSource: form.shippingLocationSource || '',
      latitude: form.shippingLatitude || '',
      longitude: form.shippingLongitude || '',
    },
  }
}

function sendHtml(res, html, statusCode = 200) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.end(html)
}

function sendJson(res, body, statusCode = 200) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

function requestWantsJson(req) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase()
  const accept = String(req.headers.accept || '').toLowerCase()
  return contentType.includes('application/json') || (accept.includes('application/json') && !accept.includes('text/html'))
}

function sendCheckoutError(req, res, message, statusCode = 400) {
  if (requestWantsJson(req)) {
    sendJson(res, { error: message }, statusCode)
    return
  }

  sendHtml(
    res,
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Checkout Could Not Start</title>
    <style>
      body {
        align-items: center;
        background: #faf9f5;
        color: #111;
        display: flex;
        font: 700 18px/1.5 Inter, Arial, sans-serif;
        justify-content: center;
        margin: 0;
        min-height: 100vh;
        padding: 24px;
      }
      main {
        background: #fff;
        border: 1px solid rgba(0, 0, 0, 0.1);
        border-radius: 18px;
        box-shadow: 0 24px 60px rgba(0, 0, 0, 0.08);
        max-width: 640px;
        padding: 34px;
      }
      h1 {
        color: #dd4c02;
        margin: 0 0 12px;
        text-transform: uppercase;
      }
      a {
        align-items: center;
        background: #dd4c02;
        border-radius: 999px;
        color: #fff;
        display: inline-flex;
        margin-top: 18px;
        min-height: 48px;
        padding: 0 24px;
        text-decoration: none;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Checkout Could Not Start</h1>
      <p>${escapeHtml(message)}</p>
      <a href="/cart">Back to Cart</a>
    </main>
  </body>
</html>`,
    statusCode,
  )
}

function getBackendOrigin(req) {
  // PayU must post its result to this backend, not directly to Shopify.
  // PUBLIC_SITE_URL has historically been set to the storefront in some
  // deployments, which makes Shopify reject PayU's POST with a 403.
  const configuredUrl = (process.env.PAYU_CALLBACK_ORIGIN || process.env.RENDER_EXTERNAL_URL)?.replace(/\/$/, '')

  if (configuredUrl) {
    return configuredUrl
  }

  const protocol = req.headers['x-forwarded-proto'] || 'http'
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:5173'
  return `${protocol}://${host}`
}

function getStoreOrigin() {
  return (process.env.BROWN_MULE_STORE_URL || 'https://brownmule.in').replace(/\/$/, '')
}

function catalogSlug(value) {
  const rawSlug = String(value || '').trim().split('::')[0]

  try {
    return decodeURIComponent(rawSlug)
      .replace(/^\/products\//i, '')
      .replace(/^\/+|\/+$/g, '')
      .toLowerCase()
  } catch {
    return rawSlug.replace(/^\/products\//i, '').replace(/^\/+|\/+$/g, '').toLowerCase()
  }
}

function cleanAddressValue(value, maximumLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maximumLength)
}

function normalizeDeliveryAddress(value) {
  const address = value && typeof value === 'object' ? value : {}
  return {
    addressLine1: cleanAddressValue(address.addressLine1 || address.shippingAddressLine1, 140),
    addressLine2: cleanAddressValue(address.addressLine2 || address.shippingAddressLine2, 140),
    addressLine3: cleanAddressValue(address.addressLine3 || address.shippingAddressLine3, 140),
    locationSource: cleanAddressValue(address.locationSource || address.shippingLocationSource, 30) || 'manual',
    latitude: cleanAddressValue(address.latitude || address.shippingLatitude, 30),
    longitude: cleanAddressValue(address.longitude || address.shippingLongitude, 30),
  }
}

function deliveryAddressIsComplete(address) {
  return Boolean(address.addressLine1 && address.addressLine2)
}

function normalizeCartItems(items) {
  if (!Array.isArray(items)) {
    return []
  }

  return items
    .map((item) => {
      const slug = catalogSlug(item?.slug)
      const product = PRODUCT_CATALOG[slug]
      const requestedQuantity = Number(item?.quantity)
      // The storefront supports separate cart lines for every grind and does
      // not impose a per-line quantity limit. Do not silently lower a valid
      // quantity here, or PayU can receive less than the cart total.
      const quantity = Number.isFinite(requestedQuantity)
        ? Math.max(1, Math.floor(requestedQuantity))
        : 1
      const grindSize = String(item?.grindSize || '').trim().slice(0, 60)

      return product
        ? {
            slug,
            name: product.name,
            price: product.price,
            quantity,
            grindSize,
          }
        : null
    })
    .filter(Boolean)
}

function calculateOrderTotals(items, couponCode) {
  const subtotal = items.reduce((total, item) => total + item.price * item.quantity, 0)
  const coffeeGst = Math.round(subtotal - subtotal / 1.05)
  const shipping = items.length ? SHIPPING_INCLUSIVE_OF_GST : 0
  const shippingGst = Math.round(shipping - shipping / 1.18)
  const coupon = String(couponCode || '').trim().toUpperCase()
  const discount = coupon === MULE_DISCOUNT_CODE ? Math.round(subtotal * 0.05) : 0

  return {
    subtotal,
    coffeeGst,
    shipping,
    shippingGst,
    discount,
    total: Math.max(0, subtotal + shipping - discount),
    coupon: discount ? MULE_DISCOUNT_CODE : '',
  }
}

function buildProductInfo(items) {
  return items
    .map((item) => `${item.name}${item.grindSize ? ` (${item.grindSize})` : ''} x ${item.quantity}`)
    .join(', ')
}

async function rememberOrder(order) {
  let orders = []

  try {
    orders = JSON.parse(await fs.readFile(ORDER_STORE, 'utf8'))
  } catch {
    orders = []
  }

  orders.push(order)
  await fs.writeFile(ORDER_STORE, JSON.stringify(orders.slice(-200), null, 2))
}

function paymentFormPage(action, fields) {
  const inputs = Object.entries(fields)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />`)
    .join('\n')

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Redirecting to PayU</title>
    <style>
      body {
        align-items: center;
        background: #2a2521;
        color: #fff8ed;
        display: flex;
        font: 700 18px/1.4 Inter, Arial, sans-serif;
        justify-content: center;
        min-height: 100vh;
        margin: 0;
      }
      main {
        text-align: center;
      }
      button {
        background: #dd4c02;
        border: 0;
        border-radius: 999px;
        color: #fff8ed;
        cursor: pointer;
        font: inherit;
        margin-top: 18px;
        padding: 14px 24px;
      }
    </style>
  </head>
  <body>
    <main>
      <p>Taking you to secure PayU checkout...</p>
      <form id="payu-form" method="post" action="${escapeHtml(action)}">
        ${inputs}
        <button type="submit">Continue to PayU</button>
      </form>
    </main>
    <script>document.getElementById('payu-form').submit()</script>
  </body>
</html>`
}

function resultPage({ title, message, status, txnid, amount, email, hashValid }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      body {
        background: #faf9f5;
        color: #111;
        font: 600 18px/1.5 Inter, Arial, sans-serif;
        margin: 0;
        min-height: 100vh;
        padding: 48px 24px;
      }
      main {
        background: #fff;
        border: 1px solid rgba(0, 0, 0, 0.1);
        border-radius: 18px;
        box-shadow: 0 24px 60px rgba(0, 0, 0, 0.08);
        margin: 0 auto;
        max-width: 760px;
        padding: 38px;
      }
      h1 {
        color: #dd4c02;
        font-size: clamp(42px, 8vw, 78px);
        line-height: .92;
        margin: 0 0 18px;
        text-transform: uppercase;
      }
      dl {
        display: grid;
        gap: 12px;
        margin: 28px 0;
      }
      div {
        display: flex;
        justify-content: space-between;
        gap: 20px;
        border-bottom: 1px solid rgba(0, 0, 0, 0.08);
        padding-bottom: 10px;
      }
      a {
        align-items: center;
        background: #dd4c02;
        border-radius: 999px;
        color: #fff;
        display: inline-flex;
        font-weight: 900;
        min-height: 48px;
        padding: 0 24px;
        text-decoration: none;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
      <dl>
        <div><dt>Status</dt><dd>${escapeHtml(status || 'Unknown')}</dd></div>
        <div><dt>Transaction ID</dt><dd>${escapeHtml(txnid || '-')}</dd></div>
        <div><dt>Amount</dt><dd>₹${escapeHtml(amount || '0.00')}</dd></div>
        <div><dt>Email</dt><dd>${escapeHtml(email || '-')}</dd></div>
        <div><dt>Security check</dt><dd>${hashValid ? 'Verified' : 'Could not verify response hash'}</dd></div>
      </dl>
      <p>Your confirmation is tied to the email used at checkout.</p>
      <a href="/#brew-showcase-title">Continue Shopping</a>
    </main>
  </body>
</html>`
}

function validatePayuResponse(fields, salt) {
  const reverseHashString = [
    salt,
    fields.status || '',
    '',
    '',
    '',
    '',
    '',
    fields.udf5 || '',
    fields.udf4 || '',
    fields.udf3 || '',
    fields.udf2 || '',
    fields.udf1 || '',
    fields.email || '',
    fields.firstname || '',
    fields.productinfo || '',
    fields.amount || '',
    fields.txnid || '',
    fields.key || '',
  ].join('|')
  const expectedHash = sha512(reverseHashString)
  const expectedHashWithCharges = fields.additional_charges
    ? sha512(`${fields.additional_charges}|${reverseHashString}`)
    : expectedHash

  return fields.hash === expectedHash || fields.hash === expectedHashWithCharges
}

async function createPayuPayment(req, res) {
  try {
    const { key, salt, paymentUrl } = getPayuConfig()
    const payload = await parseCheckoutPayload(req)
    const items = normalizeCartItems(payload.items)
    const totals = calculateOrderTotals(items, payload.couponCode)
    const customer = payload.customer || {}
    const deliveryAddress = normalizeDeliveryAddress(payload.deliveryAddress)
    const firstname = String(customer.name || 'Brown Mule Customer').trim().slice(0, 60)
    const email = String(customer.email || '').trim().toLowerCase()

    if (!items.length) {
      sendCheckoutError(req, res, 'Your cart is empty.', 400)
      return
    }

    if (!email || !email.includes('@')) {
      sendCheckoutError(req, res, 'Please log in with a valid email before checkout.', 400)
      return
    }

    if (!deliveryAddressIsComplete(deliveryAddress)) {
      sendCheckoutError(req, res, 'Add and confirm your delivery address before secure payment.', 400)
      return
    }

    // Never sign a price sent by the browser. Recompute the final cart amount
    // from the trusted catalog and the same inclusive shipping/coupon rules
    // shown in the Brown Mule order summary.
    const amount = totals.total.toFixed(2)
    const productinfo = buildProductInfo(items).slice(0, 100)
    const txnid = `BM${Date.now()}${crypto.randomBytes(3).toString('hex')}`
    const origin = getBackendOrigin(req)
    const udf1 = 'Brown Mule'
    const udf2 = items.map((item) => `${item.slug}:${item.quantity}`).join(',')
    const udf3 = ''
    const udf4 = ''
    const udf5 = ''
    const phone = process.env.PAYU_DEFAULT_PHONE || '9999999999'
    const hashString = [key, txnid, amount, productinfo, firstname, email, udf1, udf2, udf3, udf4, udf5, '', '', '', '', '', salt].join('|')
    const fields = {
      key,
      txnid,
      amount,
      productinfo,
      firstname,
      email,
      phone,
      surl: `${origin}/payu/success`,
      furl: `${origin}/payu/failure`,
      udf1,
      udf2,
      udf3,
      udf4,
      udf5,
      hash: sha512(hashString),
    }

    await rememberOrder({
      txnid,
      amount,
      email,
      firstname,
      items,
      totals,
      coupon: totals.coupon,
      deliveryAddress,
      status: 'created',
      createdAt: new Date().toISOString(),
    })

    sendHtml(res, paymentFormPage(paymentUrl, fields))
  } catch (error) {
    sendCheckoutError(req, res, error instanceof Error ? error.message : 'Payment could not be started.', 500)
  }
}

async function handlePayuResult(req, res, isSuccess) {
  const { salt } = getPayuConfig()
  const fields = req.method === 'POST' ? await parseFormBody(req) : Object.fromEntries(new URL(req.url, 'http://localhost').searchParams.entries())
  const hashValid = fields.hash ? validatePayuResponse(fields, salt) : false

  await rememberOrder({
    txnid: fields.txnid || '',
    amount: fields.amount || '',
    email: fields.email || '',
    status: fields.status || (isSuccess ? 'success' : 'failure'),
    hashValid,
    receivedAt: new Date().toISOString(),
  })

  if (!isSuccess) {
    const returnUrl = new URL('/cart', getStoreOrigin())
    returnUrl.searchParams.set('payment', 'cancelled')
    if (fields.txnid) returnUrl.searchParams.set('txnid', fields.txnid)
    res.writeHead(303, {
      Location: returnUrl.toString(),
      'Cache-Control': 'no-store',
    })
    res.end()
    return
  }

  sendHtml(
    res,
    resultPage({
      title: isSuccess ? 'Payment Successful' : 'Payment Failed',
      message: isSuccess
        ? 'Thank you. Your Brown Mule order payment was received.'
        : 'The payment was not completed. You can return to your cart and try again.',
      status: fields.status || (isSuccess ? 'success' : 'failure'),
      txnid: fields.txnid,
      amount: fields.amount,
      email: fields.email,
      hashValid,
    }),
  )
}

export async function handlePayuRequest(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

  if (url.pathname === '/api/payu/create-payment' && req.method === 'POST') {
    await createPayuPayment(req, res)
    return true
  }

  if (url.pathname === '/payu/success') {
    await handlePayuResult(req, res, true)
    return true
  }

  if (url.pathname === '/payu/failure') {
    await handlePayuResult(req, res, false)
    return true
  }

  return false
}
