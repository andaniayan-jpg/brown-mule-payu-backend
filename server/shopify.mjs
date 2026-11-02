const DEFAULT_API_VERSION = '2025-10'

function shopifyConfig() {
  const domain = String(process.env.SHOPIFY_STORE_DOMAIN || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/$/, '')
  const token = String(process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || '').trim()

  if (!domain || !token) return null

  return {
    domain,
    token,
    apiVersion: String(process.env.SHOPIFY_ADMIN_API_VERSION || DEFAULT_API_VERSION).trim(),
  }
}

export function shopifyOrdersEnabled() {
  return Boolean(shopifyConfig())
}

function amount(value) {
  return Number(value || 0).toFixed(2)
}

function clean(value, max = 255) {
  return String(value || '').trim().slice(0, max)
}

function splitName(value) {
  const parts = clean(value, 120).split(/\s+/).filter(Boolean)
  return {
    firstName: parts.shift() || 'Brown Mule Customer',
    lastName: parts.join(' '),
  }
}

function shippingAddress(address = {}) {
  const address2 = [address.addressLine2, address.addressLine3].filter(Boolean).map((value) => clean(value, 140)).join(', ')
  const full = [address.addressLine1, address.addressLine2, address.addressLine3].filter(Boolean).join(', ')
  const pin = full.match(/\b\d{6}\b/)?.[0] || ''

  return {
    address1: clean(address.addressLine1, 140),
    address2,
    city: '',
    province: '',
    country: 'India',
    country_code: 'IN',
    zip: pin,
  }
}

function noteAttributes(order) {
  const delivery = [order.deliveryAddress?.addressLine1, order.deliveryAddress?.addressLine2, order.deliveryAddress?.addressLine3]
    .filter(Boolean)
    .join(', ')
  return [
    ['PayU transaction ID', order.txnid],
    ['Payment gateway', 'PayU'],
    ['Coupon', order.coupon || 'None'],
    ['Paid amount', `₹${amount(order.amount)}`],
    ['Delivery address', delivery || 'Not provided'],
    ['Location source', order.deliveryAddress?.locationSource || 'manual'],
    ['Coordinates', [order.deliveryAddress?.latitude, order.deliveryAddress?.longitude].filter(Boolean).join(', ') || 'Not provided'],
  ].map(([name, value]) => ({ name, value: clean(value, 255) }))
}

function lineItems(order) {
  const items = Array.isArray(order.items) ? order.items : []
  const discount = Number(order.totals?.discount || 0)
  const subtotal = Number(order.totals?.subtotal || 0)
  let remainingDiscount = discount

  return items.map((item, index) => {
    const quantity = Math.max(1, Math.floor(Number(item.quantity) || 1))
    const lineSubtotal = Number(item.price || 0) * quantity
    const lineDiscount = index === items.length - 1
      ? remainingDiscount
      : Math.round((discount * lineSubtotal / Math.max(subtotal, 1)) * 100) / 100
    remainingDiscount -= lineDiscount
    const paidUnitPrice = Math.max(0, (lineSubtotal - lineDiscount) / quantity)
    const properties = []
    if (item.grindSize) properties.push({ name: 'Grind size', value: clean(item.grindSize, 60) })
    if (lineDiscount > 0) properties.push({ name: 'MULE@5 discount', value: `₹${amount(lineDiscount)}` })
    return {
      title: clean(item.name, 255),
      quantity,
      price: amount(paidUnitPrice),
      properties,
    }
  })
}

function orderPayload(order) {
  const name = splitName(order.firstname)
  return {
    order: {
      email: clean(order.email, 120),
      phone: clean(order.phone, 20),
      financial_status: 'paid',
      currency: 'INR',
      send_receipt: false,
      send_fulfillment_receipt: false,
      tags: 'Brown Mule, PayU, paid',
      note: `Paid through PayU. Transaction ID: ${clean(order.txnid, 80)}`,
      note_attributes: noteAttributes(order),
      customer: {
        first_name: clean(name.firstName, 60),
        last_name: clean(name.lastName, 60),
        email: clean(order.email, 120),
        phone: clean(order.phone, 20),
      },
      line_items: lineItems(order),
      shipping_lines: [{
        title: 'Shipping',
        price: amount(order.totals?.shipping || 0),
        code: 'BM-SHIPPING',
      }],
      shipping_address: shippingAddress(order.deliveryAddress),
      transactions: [{
        kind: 'sale',
        status: 'success',
        amount: amount(order.amount),
        gateway: 'PayU',
        authorization: clean(order.txnid, 80),
      }],
    },
  }
}

async function shopifyRequest(config, url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': config.token,
      ...(options.headers || {}),
    },
  })
  const text = await response.text()
  let body
  try { body = text ? JSON.parse(text) : {} } catch { body = { raw: text.slice(0, 500) } }
  if (!response.ok) {
    const message = body?.errors ? JSON.stringify(body.errors) : `HTTP ${response.status}`
    throw new Error(`Shopify Admin API order request failed: ${message}`)
  }
  return body
}

async function findExistingOrder(config, txnid) {
  const url = `https://${config.domain}/admin/api/${config.apiVersion}/orders.json?status=any&limit=250&fields=id,name,note,note_attributes,admin_graphql_api_id`
  const body = await shopifyRequest(config, url, { method: 'GET' })
  return (body.orders || []).find((item) =>
    item.note_attributes?.some((attribute) => attribute.name === 'PayU transaction ID' && attribute.value === txnid) ||
    String(item.note || '').includes(`Transaction ID: ${txnid}`),
  ) || null
}

export async function createShopifyOrder(order) {
  const config = shopifyConfig()
  if (!config) {
    console.info('Shopify order creation skipped: set SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_ACCESS_TOKEN.')
    return { skipped: true }
  }

  const existing = await findExistingOrder(config, order.txnid)
  if (existing) return existing

  const url = `https://${config.domain}/admin/api/${config.apiVersion}/orders.json`
  const body = await shopifyRequest(config, url, {
    method: 'POST',
    body: JSON.stringify(orderPayload(order)),
  })
  if (!body.order?.id) throw new Error('Shopify did not return a created order.')
  return body.order
}
