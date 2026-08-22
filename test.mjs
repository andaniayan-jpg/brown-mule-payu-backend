import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import { rm } from 'node:fs/promises'

const port = 31337
const baseUrl = `http://127.0.0.1:${port}`
const orderStore = new URL('./.brown-mule-orders.json', import.meta.url)
const server = spawn(process.execPath, ['server.mjs'], {
  env: {
    ...process.env,
    PORT: String(port),
    PAYU_KEY: 'test-key',
    PAYU_SALT: 'test-salt',
    PAYU_ENV: 'test',
    RESEND_API_KEY: '',
    ORDER_EMAIL_FROM: '',
    WHATSAPP_ACCESS_TOKEN: '',
    WHATSAPP_PHONE_NUMBER_ID: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

function waitForServer() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Test server did not start.')), 5000)
    server.stdout.on('data', (chunk) => {
      if (String(chunk).includes('running on port')) {
        clearTimeout(timeout)
        resolve()
      }
    })
    server.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
  })
}

try {
  await waitForServer()
  const payload = new URLSearchParams({
    customerName: 'Brown Mule Test',
    customerEmail: 'test@example.com',
    customerPhone: '9876543210',
    couponApplied: 'MULE@5',
    addressLine1: '12 Coffee Lane',
    addressLine2: 'Koramangala, Bengaluru, 560034',
    addressLine3: 'Near the roastery',
    shippingLocationSource: 'geolocation',
    items: JSON.stringify([
      { slug: 'arabica-ground::grind=moka%20pot', quantity: 10, price: '750.00', grindSize: 'Moka pot' },
    ]),
  })
  const response = await fetch(`${baseUrl}/api/payu/create-payment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: payload,
  })
  const page = await response.text()

  assert.equal(response.status, 200)
  assert.match(page, /name="amount" value="6295\.00"/)
  assert.match(page, /name="phone" value="9876543210"/)
  assert.match(page, /name="productinfo" value="Arabica Ground Coffee \(Moka pot\) x 10"/)
  assert.match(page, new RegExp(`name="furl" value="${baseUrl}/payu/failure"`))

  const screenshotCart = new URLSearchParams({
    customerName: 'Brown Mule Test',
    customerEmail: 'test@example.com',
    customerPhone: '9876543210',
    addressLine1: '12 Coffee Lane',
    addressLine2: 'Koramangala, Bengaluru, 560034',
    items: JSON.stringify([
      { slug: 'arabica', quantity: 24, price: '650.00' },
      { slug: 'robusta-ground::grind=inverted%20aero%20press', quantity: 8, price: '500.00', grindSize: 'Inverted aero press' },
      { slug: 'robusta-ground::grind=espresso', quantity: 3, price: '500.00', grindSize: 'Espresso' },
      { slug: 'robusta-ground::grind=french%20press', quantity: 20, price: '500.00', grindSize: 'French press' },
    ]),
  })
  const screenshotResponse = await fetch(`${baseUrl}/api/payu/create-payment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: screenshotCart,
  })
  assert.equal(screenshotResponse.status, 200)
  assert.match(await screenshotResponse.text(), /name="amount" value="31220\.00"/)

  const deliveryStep = await fetch(`${baseUrl}/api/payu/create-payment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      customerName: 'Brown Mule Test',
      customerEmail: 'test@example.com',
      items: JSON.stringify([{ slug: 'arabica-ground', quantity: 1 }]),
    }),
  })
  assert.equal(deliveryStep.status, 200)
  const deliveryPage = await deliveryStep.text()
  assert.match(deliveryPage, /Delivery &amp; contact details/)
  assert.match(deliveryPage, /Use my current location/)
  assert.match(deliveryPage, /Continue to secure PayU payment/)

  const txnid = page.match(/name="txnid" value="([^"]+)"/)[1]
  const successFields = {
    status: 'success',
    txnid,
    amount: '6295.00',
    productinfo: 'Arabica Ground Coffee (Moka pot) x 10',
    firstname: 'Brown Mule Test',
    email: 'test@example.com',
    phone: '9876543210',
    key: 'test-key',
    udf1: 'Brown Mule',
    udf2: 'arabica-ground:10',
    udf3: '12 Coffee Lane',
    udf4: 'Koramangala, Bengaluru, 560034',
    udf5: 'Near the roastery',
  }
  successFields.hash = crypto.createHash('sha512').update([
    'test-salt', successFields.status, '', '', '', '', '', successFields.udf5,
    successFields.udf4, successFields.udf3, successFields.udf2, successFields.udf1,
    successFields.email, successFields.firstname, successFields.productinfo,
    successFields.amount, successFields.txnid, successFields.key,
  ].join('|')).digest('hex')
  const confirmed = await fetch(`${baseUrl}/payu/success`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(successFields),
  })
  assert.equal(confirmed.status, 303)
  assert.equal(confirmed.headers.get('location'), `https://brownmule.in/cart?payment=success&txnid=${txnid}`)

  const cancelled = await fetch(`${baseUrl}/payu/failure`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ status: 'failure', txnid: 'BM-CANCELLED' }),
  })
  assert.equal(cancelled.status, 303)
  assert.equal(cancelled.headers.get('location'), 'https://brownmule.in/cart?payment=cancelled&txnid=BM-CANCELLED')
  console.log('PayU amount test passed: ₹6,295.00')
} finally {
  server.kill()
  await rm(orderStore, { force: true })
}
