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
        phone: customer.phone || payload.customerPhone || payload.phone || '',
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
      phone: form.customerPhone || form.phone || '',
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

function normalizeCustomerName(value) {
  return cleanAddressValue(value, 60)
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase().slice(0, 120)
}

function emailIsValid(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function normalizePhone(value) {
  let digits = String(value || '').replace(/\D/g, '')

  if (digits.length === 12 && digits.startsWith('91')) {
    digits = digits.slice(2)
  }

  return digits.slice(0, 10)
}

function phoneIsValid(phone) {
  return /^[6-9]\d{9}$/.test(phone)
}

function formatDeliveryAddress(address) {
  return [address.addressLine1, address.addressLine2, address.addressLine3].filter(Boolean).join(', ')
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

async function findCreatedOrder(txnid) {
  if (!txnid) return null

  try {
    const orders = JSON.parse(await fs.readFile(ORDER_STORE, 'utf8'))
    return [...orders].reverse().find((order) => order.txnid === txnid && Array.isArray(order.items)) || null
  } catch {
    return null
  }
}

function hiddenInput(name, value) {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />`
}

function checkoutDetailsPage({ items, totals, customer, deliveryAddress, message = '' }) {
  const safeCustomer = customer || {}
  const safeAddress = deliveryAddress || {}
  const serializedItems = JSON.stringify(items.map((item) => ({
    slug: item.slug,
    quantity: item.quantity,
    grindSize: item.grindSize,
  })))
  const itemSummary = items
    .map((item) => `${escapeHtml(item.name)}${item.grindSize ? ` — ${escapeHtml(item.grindSize)}` : ''} × ${item.quantity}`)
    .join('<br />')
  const formMessage = message
    ? `<p class="notice" role="alert">${escapeHtml(message)}</p>`
    : '<p class="helper">Enter your delivery and contact information. It is used only to process and confirm this order.</p>'

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Delivery details | Brown Mule</title>
    <style>
      :root { color-scheme: light; }
      * { box-sizing: border-box; }
      body { background: #f7f3ec; color: #241007; font: 500 16px/1.45 Inter, Arial, sans-serif; margin: 0; }
      main { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(260px, .65fr); gap: 28px; margin: 0 auto; max-width: 1040px; padding: clamp(22px, 5vw, 64px) 24px; }
      section, aside { background: #fffdf8; border: 1px solid rgba(66, 35, 15, .13); border-radius: 20px; box-shadow: 0 18px 45px rgba(60, 32, 12, .08); padding: clamp(22px, 4vw, 38px); }
      .brand { color: #d94b10; font-size: 12px; font-weight: 900; letter-spacing: .14em; margin: 0 0 10px; text-transform: uppercase; }
      h1 { color: #1f0e06; font-family: Georgia, 'Times New Roman', serif; font-size: clamp(32px, 5vw, 48px); line-height: 1; margin: 0 0 12px; }
      h2 { font-size: 17px; margin: 0 0 14px; }
      .helper, .notice { color: rgba(36, 16, 7, .72); margin: 0 0 24px; }
      .notice { background: #fff0e8; border-left: 4px solid #d94b10; border-radius: 8px; color: #8c3008; padding: 11px 13px; }
      form, .fields { display: grid; gap: 16px; }
      .fields { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      label { color: #4b2918; display: grid; font-size: 13px; font-weight: 800; gap: 7px; }
      label.full { grid-column: 1 / -1; }
      input { appearance: none; background: #fff; border: 1px solid rgba(66, 35, 15, .2); border-radius: 10px; color: #241007; font: 650 16px/1.2 Inter, Arial, sans-serif; min-height: 48px; outline: none; padding: 12px 13px; width: 100%; }
      input:focus { border-color: #dd4c02; box-shadow: 0 0 0 4px rgba(221, 76, 2, .12); }
      .location { align-items: center; background: transparent; border: 1px solid rgba(66, 35, 15, .22); border-radius: 999px; color: #4a2414; cursor: pointer; display: inline-flex; font: 800 13px/1 Inter, Arial, sans-serif; justify-content: center; min-height: 44px; padding: 0 16px; transition: transform .18s ease, border-color .18s ease; }
      .location:hover, .location:focus-visible { border-color: #dd4c02; outline: none; transform: translateY(-1px); }
      .location:disabled { cursor: wait; opacity: .65; transform: none; }
      #location-status { color: rgba(36, 16, 7, .68); font-size: 13px; font-weight: 650; margin: -5px 0 0; min-height: 20px; }
      .submit { background: #dd4c02; border: 0; border-radius: 999px; color: #fffaf0; cursor: pointer; font: 900 15px/1 Inter, Arial, sans-serif; margin-top: 6px; min-height: 54px; padding: 0 22px; transition: background .18s ease, transform .18s ease; }
      .submit:hover, .submit:focus-visible { background: #b83d09; outline: none; transform: translateY(-1px); }
      .back { color: #7b3413; display: inline-block; font-size: 13px; font-weight: 800; margin-top: 18px; text-decoration: none; }
      aside { align-self: start; }
      .items { border-bottom: 1px solid rgba(66, 35, 15, .12); color: rgba(36, 16, 7, .76); font-size: 14px; line-height: 1.65; margin: 0 0 16px; padding-bottom: 16px; }
      .total { align-items: baseline; display: flex; font-size: 15px; font-weight: 800; justify-content: space-between; }
      .total strong { color: #1f0e06; font-size: 26px; }
      .fine-print { color: rgba(36, 16, 7, .58); font-size: 12px; line-height: 1.45; margin: 18px 0 0; }
      @media (max-width: 760px) { main { grid-template-columns: 1fr; } aside { grid-row: 1; } }
      @media (max-width: 520px) { main { padding: 16px; } section, aside { border-radius: 16px; padding: 22px; } .fields { grid-template-columns: 1fr; } }
      @media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; } }
    </style>
  </head>
  <body>
    <main>
      <section>
        <p class="brand">Brown Mule · Secure checkout</p>
        <h1>Delivery &amp; contact details</h1>
        ${formMessage}
        <form method="post" action="/api/payu/create-payment" novalidate>
          ${hiddenInput('items', serializedItems)}
          ${hiddenInput('couponApplied', totals.coupon)}
          ${hiddenInput('shippingLocationSource', safeAddress.locationSource || 'manual')}
          ${hiddenInput('shippingLatitude', safeAddress.latitude || '')}
          ${hiddenInput('shippingLongitude', safeAddress.longitude || '')}
          <div class="fields">
            <label>Full name<input name="customerName" autocomplete="name" required value="${escapeHtml(safeCustomer.name || '')}" /></label>
            <label>Email address<input name="customerEmail" type="email" autocomplete="email" required value="${escapeHtml(safeCustomer.email || '')}" /></label>
            <label class="full">Mobile number<input name="customerPhone" type="tel" inputmode="numeric" autocomplete="tel" pattern="[6-9][0-9]{9}" title="Enter a valid 10-digit Indian mobile number" required value="${escapeHtml(safeCustomer.phone || '')}" /></label>
            <label class="full">House / building and street<input name="addressLine1" autocomplete="address-line1" required value="${escapeHtml(safeAddress.addressLine1 || '')}" /></label>
            <label class="full">Area, city, state and PIN code<input name="addressLine2" autocomplete="address-line2" required value="${escapeHtml(safeAddress.addressLine2 || '')}" /></label>
            <label class="full">Landmark <span>(optional)</span><input name="addressLine3" autocomplete="address-line3" value="${escapeHtml(safeAddress.addressLine3 || '')}" /></label>
          </div>
          <button class="location" type="button" id="use-location">Use my current location</button>
          <p id="location-status" role="status" aria-live="polite"></p>
          <button class="submit" type="submit">Continue to secure PayU payment</button>
        </form>
        <a class="back" href="${escapeHtml(new URL('/cart', getStoreOrigin()).toString())}">← Return to cart</a>
      </section>
      <aside aria-label="Order summary">
        <h2>Order summary</h2>
        <p class="items">${itemSummary}</p>
        <p class="total"><span>Total payable</span><strong>₹${escapeHtml(totals.total.toFixed(2))}</strong></p>
        <p class="fine-print">This amount includes shipping and all applicable GST, after any eligible discount. The same total is sent to PayU.</p>
      </aside>
    </main>
    <script>
      (function () {
        var locationButton = document.getElementById('use-location');
        var status = document.getElementById('location-status');
        var form = locationButton.closest('form');
        var fields = {
          line1: form.elements.addressLine1,
          line2: form.elements.addressLine2,
          line3: form.elements.addressLine3,
          source: form.elements.shippingLocationSource,
          latitude: form.elements.shippingLatitude,
          longitude: form.elements.shippingLongitude
        };

        function unique(values) {
          var seen = [];
          return values.map(function (value) { return String(value || '').replace(/\\s+/g, ' ').trim(); }).filter(function (value) {
            if (!value || seen.indexOf(value.toLowerCase()) !== -1) return false;
            seen.push(value.toLowerCase());
            return true;
          });
        }

        function setStatus(message) { status.textContent = message || ''; }

        function applyAddress(address) {
          fields.line1.value = address.line1 || '';
          fields.line2.value = address.line2 || '';
          fields.line3.value = address.line3 || '';
          fields.source.value = 'geolocation';
          fields.latitude.value = String(address.latitude || '');
          fields.longitude.value = String(address.longitude || '');
        }

        function addressFromNominatim(data, latitude, longitude) {
          var address = data && data.address || {};
          var display = String(data && data.display_name || '').split(',');
          var street = unique([address.house_number, address.road || address.pedestrian || address.neighbourhood]).join(' ');
          var place = address.suburb || address.village || address.town || address.city || address.municipality || '';
          return {
            line1: street || unique(display.slice(0, 2)).join(', ') || 'Current location',
            line2: unique([place, address.state_district, address.state, address.postcode]).join(', ') || unique(display.slice(2, 5)).join(', ') || ('Lat ' + latitude.toFixed(6) + ', Lng ' + longitude.toFixed(6)),
            line3: address.country || '', latitude: latitude, longitude: longitude
          };
        }

        function addressFromFallback(data, latitude, longitude) {
          var line1 = data.locality || data.city || data.principalSubdivision || 'Current location';
          return {
            line1: line1,
            line2: unique([data.city !== line1 ? data.city : '', data.principalSubdivision, data.postcode]).join(', ') || ('Lat ' + latitude.toFixed(6) + ', Lng ' + longitude.toFixed(6)),
            line3: data.countryName || '', latitude: latitude, longitude: longitude
          };
        }

        function reverseGeocode(latitude, longitude) {
          var nominatim = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&lat=' + encodeURIComponent(latitude) + '&lon=' + encodeURIComponent(longitude);
          var fallback = 'https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=' + encodeURIComponent(latitude) + '&longitude=' + encodeURIComponent(longitude) + '&localityLanguage=en';
          return fetch(nominatim).then(function (response) {
            if (!response.ok) throw new Error('Address lookup failed.');
            return response.json();
          }).then(function (data) {
            return addressFromNominatim(data, latitude, longitude);
          }).catch(function () {
            return fetch(fallback).then(function (response) {
              if (!response.ok) throw new Error('Address lookup failed.');
              return response.json();
            }).then(function (data) {
              return addressFromFallback(data, latitude, longitude);
            });
          });
        }

        locationButton.addEventListener('click', function () {
          if (!navigator.geolocation) { setStatus('Location services are not available in this browser. Please enter your address manually.'); return; }
          locationButton.disabled = true;
          locationButton.textContent = 'Finding your location…';
          setStatus('Requesting your current location…');
          navigator.geolocation.getCurrentPosition(function (position) {
            var latitude = position.coords.latitude;
            var longitude = position.coords.longitude;
            setStatus('Adding your delivery address…');
            reverseGeocode(latitude, longitude).then(function (address) {
              applyAddress(address);
              setStatus('Location added. Please check the address before continuing.');
            }).catch(function () {
              applyAddress({ line1: 'Current location', line2: 'Lat ' + latitude.toFixed(6) + ', Lng ' + longitude.toFixed(6), latitude: latitude, longitude: longitude });
              setStatus('Location coordinates added. Please complete the address details.');
            }).then(function () {
              locationButton.disabled = false;
              locationButton.textContent = 'Use my current location';
            });
          }, function () {
            locationButton.disabled = false;
            locationButton.textContent = 'Use my current location';
            setStatus('Location permission was not granted. Please enter your address manually.');
          }, { enableHighAccuracy: true, maximumAge: 60000, timeout: 15000 });
        });
      })();
    </script>
  </body>
</html>`
}

function notificationOrderFromCallback(fields, storedOrder) {
  const callbackAddress = normalizeDeliveryAddress({
    addressLine1: fields.udf3,
    addressLine2: fields.udf4,
    addressLine3: fields.udf5,
  })
  const customer = storedOrder || {}

  return {
    txnid: fields.txnid || customer.txnid || '',
    amount: fields.amount || customer.amount || '',
    firstname: normalizeCustomerName(fields.firstname || customer.firstname || 'Brown Mule Customer'),
    email: normalizeEmail(fields.email || customer.email || ''),
    phone: normalizePhone(fields.phone || customer.phone || ''),
    deliveryAddress: deliveryAddressIsComplete(callbackAddress) ? callbackAddress : (customer.deliveryAddress || callbackAddress),
    items: customer.items || [],
    totals: customer.totals || { total: Number(fields.amount || 0) },
  }
}

function orderNotificationText(order) {
  const delivery = formatDeliveryAddress(order.deliveryAddress || {}) || 'Address unavailable'
  const items = Array.isArray(order.items) && order.items.length
    ? order.items.map((item) => `${item.name}${item.grindSize ? ` (${item.grindSize})` : ''} x ${item.quantity}`).join(', ')
    : 'Item details are available in PayU.'

  return [
    'New paid Brown Mule order',
    `Order: ${order.txnid || '-'}`,
    `Customer: ${order.firstname || '-'}`,
    `Email: ${order.email || '-'}`,
    `Phone: ${order.phone || '-'}`,
    `Delivery address: ${delivery}`,
    `Items: ${items}`,
    `Amount paid: ₹${order.amount || Number(order.totals?.total || 0).toFixed(2)}`,
  ].join('\n')
}

async function fetchWithTimeout(url, options, timeout = 12000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)

  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function sendOrderEmail(order) {
  const apiKey = process.env.RESEND_API_KEY
  const from = process.env.ORDER_EMAIL_FROM
  const to = process.env.ORDER_EMAIL_TO || 'brownmule01@gmail.com'

  if (!apiKey || !from) {
    console.info('Order email skipped: set RESEND_API_KEY and ORDER_EMAIL_FROM to enable it.')
    return { skipped: true }
  }

  const text = orderNotificationText(order)
  const response = await fetchWithTimeout('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: `Paid Brown Mule order ${order.txnid || ''}`.trim(),
      text,
      html: `<pre style="font:14px/1.55 Arial,sans-serif;white-space:pre-wrap">${escapeHtml(text)}</pre>`,
    }),
  })

  if (!response.ok) {
    throw new Error(`Order email failed (${response.status}).`)
  }

  return { sent: true }
}

function whatsappRecipient(phone) {
  const normalized = normalizePhone(phone)
  return normalized ? `91${normalized}` : ''
}

async function sendWhatsappConfirmation(order) {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID
  const recipient = whatsappRecipient(order.phone)

  if (!accessToken || !phoneNumberId || !recipient) {
    console.info('WhatsApp confirmation skipped: set WhatsApp credentials and collect a valid customer phone number.')
    return { skipped: true }
  }

  const templateName = process.env.WHATSAPP_TEMPLATE_NAME || 'brown_mule_order_confirmation'
  const languageCode = process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'en_US'
  const total = String(order.amount || Number(order.totals?.total || 0).toFixed(2))
  const address = formatDeliveryAddress(order.deliveryAddress || {}) || 'your saved delivery address'
  const response = await fetchWithTimeout(`https://graph.facebook.com/${process.env.WHATSAPP_GRAPH_API_VERSION || 'v22.0'}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: recipient,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        components: [{
          type: 'body',
          parameters: [
            { type: 'text', text: order.firstname || 'Customer' },
            { type: 'text', text: order.txnid || '-' },
            { type: 'text', text: `₹${total}` },
            { type: 'text', text: address },
          ],
        }],
      },
    }),
  })

  if (!response.ok) {
    throw new Error(`WhatsApp confirmation failed (${response.status}).`)
  }

  return { sent: true }
}

async function sendOrderNotifications(order) {
  const outcomes = await Promise.allSettled([sendOrderEmail(order), sendWhatsappConfirmation(order)])
  outcomes.forEach((outcome) => {
    if (outcome.status === 'rejected') {
      console.error('Order notification failed:', outcome.reason)
    }
  })
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
    const firstname = normalizeCustomerName(customer.name)
    const email = normalizeEmail(customer.email)
    const phone = normalizePhone(customer.phone)

    if (!items.length) {
      sendCheckoutError(req, res, 'Your cart is empty.', 400)
      return
    }

    if (!firstname || !emailIsValid(email) || !phoneIsValid(phone) || !deliveryAddressIsComplete(deliveryAddress)) {
      if (requestWantsJson(req)) {
        sendCheckoutError(req, res, 'Complete your name, email, 10-digit mobile number, and delivery address before secure payment.', 400)
        return
      }

      sendHtml(res, checkoutDetailsPage({
        items,
        totals,
        customer: { name: firstname, email, phone },
        deliveryAddress,
        message: 'Please complete your name, email, 10-digit mobile number, and delivery address to continue.',
      }))
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
    // PayU returns its UDF fields in the signed callback. Keeping the
    // address there lets the confirmed-payment notification still contain
    // delivery details if the service has restarted in the meantime.
    const udf3 = deliveryAddress.addressLine1
    const udf4 = deliveryAddress.addressLine2
    const udf5 = deliveryAddress.addressLine3
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
      phone,
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

  const createdOrder = await findCreatedOrder(fields.txnid)
  const confirmed = isSuccess && String(fields.status || '').toLowerCase() === 'success' && hashValid

  await rememberOrder({
    txnid: fields.txnid || '',
    amount: fields.amount || '',
    email: fields.email || '',
    status: confirmed ? 'success' : (fields.status || (isSuccess ? 'success' : 'failure')),
    hashValid,
    receivedAt: new Date().toISOString(),
  })

  if (!confirmed) {
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

  // A notification failure must never turn a paid order into an error page.
  // Awaiting here only gives the message providers the confirmed details
  // before the customer sees their order-complete screen.
  await sendOrderNotifications(notificationOrderFromCallback(fields, createdOrder))

  const returnUrl = new URL('/cart', getStoreOrigin())
  returnUrl.searchParams.set('payment', 'success')
  if (fields.txnid) returnUrl.searchParams.set('txnid', fields.txnid)
  res.writeHead(303, {
    Location: returnUrl.toString(),
    'Cache-Control': 'no-store',
  })
  res.end()
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
