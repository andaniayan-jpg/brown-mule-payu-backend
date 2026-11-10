import crypto from 'node:crypto'
import { claimSmsFallback, completeSmsFallback, checkoutForWhatsappMessage, recordWhatsappMessage } from './first-order.mjs'

const money = (value) => `Rs ${Number(value || 0).toFixed(2)}`
const mobile = (value) => /^\d{10}$/.test(String(value || '').replace(/\D/g, '').slice(-10))
  ? `91${String(value).replace(/\D/g, '').slice(-10)}` : ''

function orderNumber(order) {
  return order.shopifyOrderNumber || order.txnid || 'your order'
}

function itemLines(order) {
  return (order.items || []).map((item) =>
    `${item.name}${item.grindSize ? ` (${item.grindSize})` : ''} × ${item.quantity} — ${money(Number(item.price || 0) * Number(item.quantity || 1))}`)
}

export function customerConfirmationText(order) {
  return [
    `Brown Mule order ${orderNumber(order)} confirmed`,
    `Thanks, ${order.firstname || 'Customer'}! Your PayU payment was successful.`,
    '',
    ...itemLines(order),
    `Subtotal: ${money(order.totals?.subtotal)}`,
    `Shipping: ${money(order.totals?.shipping)}`,
    ...(Number(order.totals?.discount) > 0 ? [`Discount: -${money(order.totals.discount)}`] : []),
    `Paid: ${money(order.amount)}`,
    `Delivery address: ${[order.deliveryAddress?.addressLine1, order.deliveryAddress?.addressLine2, order.deliveryAddress?.addressLine3].filter(Boolean).join(', ') || 'As entered at checkout'}`,
    `Payment reference: ${order.txnid || '-'}`,
    '',
    'This is an order confirmation, not a tax invoice.',
  ].join('\n')
}

async function sendCustomerEmail(order) {
  const apiKey = process.env.RESEND_API_KEY
  const from = process.env.ORDER_EMAIL_FROM
  if (!apiKey || !from || !order.email) {
    console.info('Customer confirmation email skipped: configure RESEND_API_KEY and ORDER_EMAIL_FROM.')
    return
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [order.email],
      subject: `Brown Mule order ${orderNumber(order)} confirmed`,
      text: customerConfirmationText(order),
    }),
    signal: AbortSignal.timeout(12000),
  })
  if (!response.ok) throw new Error(`Customer email provider rejected the message (${response.status}).`)
  console.info(`Customer confirmation email accepted for ${order.txnid}.`)
}

async function sendSmsFallback(order) {
  const sid = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  const sender = process.env.TWILIO_MESSAGING_SERVICE_SID || process.env.TWILIO_SMS_FROM
  const to = mobile(order.phone)
  if (!sid || !token || !sender || !to) {
    console.info(`SMS fallback unavailable for ${order.txnid}: configure Twilio and an approved Indian sender.`)
    return
  }
  if (!await claimSmsFallback(order.txnid)) return
  try {
    const params = new URLSearchParams({ To: `+${to}`, Body: customerConfirmationText(order) })
    params.set(process.env.TWILIO_MESSAGING_SERVICE_SID ? 'MessagingServiceSid' : 'From', sender)
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
      signal: AbortSignal.timeout(12000),
    })
    if (!response.ok) throw new Error(`SMS provider rejected the message (${response.status}).`)
    await completeSmsFallback(order.txnid, true)
    console.info(`SMS fallback accepted for ${order.txnid}.`)
  } catch (error) {
    await completeSmsFallback(order.txnid, false)
    throw error
  }
}

async function sendWhatsapp(order) {
  if (!order.whatsappOptIn) return false
  const token = process.env.WHATSAPP_ACCESS_TOKEN
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID
  const to = mobile(order.phone)
  if (!token || !phoneId || !to) return false
  const template = process.env.WHATSAPP_TEMPLATE_NAME || 'brown_mule_order_confirmation'
  const summaryTemplate = process.env.WHATSAPP_TEMPLATE_STYLE === 'itemized'
  const address = [order.deliveryAddress?.addressLine1, order.deliveryAddress?.addressLine2, order.deliveryAddress?.addressLine3].filter(Boolean).join(', ')
  const parameters = summaryTemplate
    ? [order.firstname || 'Customer', orderNumber(order), itemLines(order).join('; ') || 'Coffee', money(order.amount)]
    : [order.firstname || 'Customer', order.txnid || '-', `₹${Number(order.amount || 0).toFixed(2)}`, address || 'your saved delivery address']
  const response = await fetch(`https://graph.facebook.com/${process.env.WHATSAPP_GRAPH_API_VERSION || 'v22.0'}/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template', template: {
      name: template, language: { code: process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'en_US' },
      components: [{ type: 'body', parameters: parameters.map((text) => ({ type: 'text', text: String(text).slice(0, 1024) })) }],
    } }),
    signal: AbortSignal.timeout(12000),
  })
  if (!response.ok) throw new Error(`WhatsApp provider rejected the message (${response.status}).`)
  const body = await response.json()
  const messageId = body.messages?.[0]?.id
  if (!messageId) throw new Error('WhatsApp accepted the request without a message ID.')
  await recordWhatsappMessage(order.txnid, messageId)
  console.info(`WhatsApp confirmation accepted for ${order.txnid}.`)
  return true
}

export async function sendCustomerConfirmations(order) {
  const outcomes = await Promise.allSettled([
    order.shopifyOrderNumber ? Promise.resolve() : sendCustomerEmail(order),
    (async () => {
      try {
        if (!await sendWhatsapp(order)) await sendSmsFallback(order)
      } catch (error) {
        console.error('WhatsApp confirmation failed:', error)
        await sendSmsFallback(order)
      }
    })(),
  ])
  for (const outcome of outcomes) if (outcome.status === 'rejected') console.error('Customer confirmation failed:', outcome.reason)
}

export async function handleWhatsappWebhook(req, res, url) {
  if (url.pathname !== '/api/whatsapp/webhook') return false
  if (req.method === 'GET') {
    const valid = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN &&
      url.searchParams.get('hub.mode') === 'subscribe' &&
      url.searchParams.get('hub.verify_token') === process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN
    res.writeHead(valid ? 200 : 403, { 'Content-Type': 'text/plain' })
    res.end(valid ? url.searchParams.get('hub.challenge') || '' : 'Forbidden')
    return true
  }
  if (req.method !== 'POST') { res.writeHead(405).end(); return true }
  const secret = process.env.WHATSAPP_APP_SECRET
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1024 * 1024) { res.writeHead(413).end(); return true }
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks)
  const supplied = String(req.headers['x-hub-signature-256'] || '')
  const expected = secret ? `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}` : ''
  if (!expected || supplied.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    res.writeHead(401).end()
    return true
  }
  const event = JSON.parse(raw.toString('utf8'))
  for (const entry of event.entry || []) for (const change of entry.changes || []) for (const status of change.value?.statuses || []) {
    if (status.status !== 'failed') continue
    const order = await checkoutForWhatsappMessage(status.id)
    if (order) await sendSmsFallback(order)
  }
  res.writeHead(200).end('OK')
  return true
}
