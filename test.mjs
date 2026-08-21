import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
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
    couponApplied: 'MULE@5',
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
  assert.match(page, /name="productinfo" value="Arabica Ground Coffee \(Moka pot\) x 10"/)
  console.log('PayU amount test passed: ₹6,295.00')
} finally {
  server.kill()
  await rm(orderStore, { force: true })
}
