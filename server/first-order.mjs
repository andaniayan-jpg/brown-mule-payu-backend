import fs from 'node:fs/promises'
import path from 'node:path'

const localFile = path.resolve(process.cwd(), process.env.BROWN_MULE_LOCAL_STORE_PATH || '.brown-mule-first-orders.json')
const localMode = process.env.BROWN_MULE_LOCAL_STORE === '1'
let poolPromise
let localQueue = Promise.resolve()

async function database() {
  if (localMode) return null
  if (!process.env.DATABASE_URL) return null
  if (!poolPromise) {
    poolPromise = (async () => {
      const { Pool } = await import('pg')
      const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 })
      await pool.query(`CREATE TABLE IF NOT EXISTS bm_payu_checkouts (
        txnid text PRIMARY KEY,
        phone text NOT NULL,
        amount numeric(12,2) NOT NULL,
        coupon text NOT NULL DEFAULT '',
        status text NOT NULL DEFAULT 'created',
        order_data jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`)
      await pool.query(`CREATE INDEX IF NOT EXISTS bm_payu_checkouts_phone_status
        ON bm_payu_checkouts (phone, status)`)
      await pool.query(`CREATE TABLE IF NOT EXISTS bm_payu_coupon_claims (
        phone text PRIMARY KEY,
        txnid text NOT NULL,
        status text NOT NULL,
        expires_at timestamptz NOT NULL
      )`)
      await pool.query(`CREATE TABLE IF NOT EXISTS bm_payu_message_delivery (
        txnid text PRIMARY KEY,
        whatsapp_message_id text UNIQUE,
        sms_state text NOT NULL DEFAULT 'none',
        updated_at timestamptz NOT NULL DEFAULT now()
      )`)
      return pool
    })().catch((error) => {
      poolPromise = undefined
      throw error
    })
  }
  return poolPromise
}

export async function recordWhatsappMessage(txnid, messageId) {
  if (!txnid || !messageId) return
  const pool = await database()
  if (!pool) return withLocalLock((data) => {
    if (!data.checkouts[txnid]) return { value: false }
    data.checkouts[txnid].whatsappMessageId = messageId
    return { changed: true, value: true }
  })
  await pool.query(`INSERT INTO bm_payu_message_delivery (txnid, whatsapp_message_id)
    VALUES ($1, $2) ON CONFLICT (txnid) DO UPDATE SET
    whatsapp_message_id = EXCLUDED.whatsapp_message_id, updated_at = now()`, [txnid, messageId])
}

export async function checkoutForWhatsappMessage(messageId) {
  if (!messageId) return null
  const pool = await database()
  if (!pool) return withLocalLock((data) => ({
    value: Object.values(data.checkouts).find((order) => order.whatsappMessageId === messageId && order.status === 'success') || null,
  }))
  const result = await pool.query(`SELECT c.order_data FROM bm_payu_message_delivery m
    JOIN bm_payu_checkouts c ON c.txnid = m.txnid
    WHERE m.whatsapp_message_id = $1 AND c.status = 'success'`, [messageId])
  return result.rows[0]?.order_data || null
}

export async function claimSmsFallback(txnid) {
  const pool = await database()
  if (!pool) return withLocalLock((data) => {
    const order = data.checkouts[txnid]
    if (!order || order.status !== 'success' || ['sending', 'sent'].includes(order.smsState)) return { value: false }
    order.smsState = 'sending'
    return { changed: true, value: true }
  })
  const result = await pool.query(`INSERT INTO bm_payu_message_delivery (txnid, sms_state)
    SELECT txnid, 'sending' FROM bm_payu_checkouts WHERE txnid = $1 AND status = 'success'
    ON CONFLICT (txnid) DO UPDATE SET sms_state = 'sending', updated_at = now()
    WHERE bm_payu_message_delivery.sms_state NOT IN ('sending', 'sent')
    RETURNING txnid`, [txnid])
  return result.rowCount > 0
}

export async function completeSmsFallback(txnid, sent) {
  const pool = await database()
  if (!pool) return withLocalLock((data) => {
    if (!data.checkouts[txnid]) return { value: false }
    data.checkouts[txnid].smsState = sent ? 'sent' : 'retry'
    return { changed: true, value: true }
  })
  await pool.query(`UPDATE bm_payu_message_delivery SET sms_state = $2, updated_at = now()
    WHERE txnid = $1`, [txnid, sent ? 'sent' : 'retry'])
}

async function readLocal() {
  try {
    const data = JSON.parse(await fs.readFile(localFile, 'utf8'))
    return data && typeof data === 'object' ? data : { checkouts: {}, claims: {} }
  } catch {
    return { checkouts: {}, claims: {} }
  }
}

async function writeLocal(data) {
  const temporary = `${localFile}.${process.pid}.tmp`
  await fs.writeFile(temporary, JSON.stringify(data, null, 2))
  await fs.rename(temporary, localFile)
}

function withLocalLock(action) {
  const work = localQueue.then(async () => {
    const data = await readLocal()
    const result = await action(data)
    if (result?.changed) await writeLocal(data)
    return result?.value
  })
  localQueue = work.catch(() => {})
  return work
}

function localEligibility(data, phone) {
  const paid = Object.values(data.checkouts).some((order) => order.phone === phone && order.status === 'success')
  const claim = data.claims[phone]
  const pending = claim?.status === 'pending' && Date.parse(claim.expiresAt) > Date.now()
  return !paid && !pending
}

export async function firstOrderEligible(phone) {
  if (!phone) return false
  const pool = await database()
  if (!pool) {
    if (!localMode) throw new Error('First-order discounts are temporarily unavailable. Please try again later.')
    return withLocalLock((data) => ({ value: localEligibility(data, phone) }))
  }
  const result = await pool.query(`SELECT
    EXISTS(SELECT 1 FROM bm_payu_checkouts WHERE phone = $1 AND status = 'success') AS paid,
    EXISTS(SELECT 1 FROM bm_payu_coupon_claims WHERE phone = $1 AND status = 'pending' AND expires_at > now()) AS pending`, [phone])
  return !result.rows[0].paid && !result.rows[0].pending
}

export async function createCheckout(order) {
  const pool = await database()
  if (!pool) {
    if (order.coupon && !localMode) throw new Error('First-order discounts are temporarily unavailable. Please try again later.')
    return withLocalLock((data) => {
    if (order.coupon && !localEligibility(data, order.phone)) return { value: false }
    data.checkouts[order.txnid] = { ...order, status: 'created' }
    if (order.coupon) data.claims[order.phone] = {
      txnid: order.txnid,
      status: 'pending',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }
    return { changed: true, value: true }
    })
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [order.phone])
    if (order.coupon) {
      const eligible = await client.query(`SELECT
        EXISTS(SELECT 1 FROM bm_payu_checkouts WHERE phone = $1 AND status = 'success') AS paid,
        EXISTS(SELECT 1 FROM bm_payu_coupon_claims WHERE phone = $1 AND status = 'pending' AND expires_at > now()) AS pending`, [order.phone])
      if (eligible.rows[0].paid || eligible.rows[0].pending) {
        await client.query('ROLLBACK')
        return false
      }
      await client.query(`INSERT INTO bm_payu_coupon_claims (phone, txnid, status, expires_at)
        VALUES ($1, $2, 'pending', now() + interval '1 hour')
        ON CONFLICT (phone) DO UPDATE SET txnid = EXCLUDED.txnid, status = 'pending', expires_at = EXCLUDED.expires_at`, [order.phone, order.txnid])
    }
    await client.query(`INSERT INTO bm_payu_checkouts (txnid, phone, amount, coupon, order_data)
      VALUES ($1, $2, $3, $4, $5)`, [order.txnid, order.phone, order.amount, order.coupon || '', JSON.stringify(order)])
    await client.query('COMMIT')
    return true
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function getCheckout(txnid) {
  if (!txnid) return null
  const pool = await database()
  if (!pool) return withLocalLock((data) => ({ value: data.checkouts[txnid] || null }))
  const result = await pool.query('SELECT order_data, status FROM bm_payu_checkouts WHERE txnid = $1', [txnid])
  return result.rows[0] ? { ...result.rows[0].order_data, status: result.rows[0].status } : null
}

export async function listShopifySyncPending(limit = 50) {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 50)))
  const pool = await database()
  if (!pool) {
    if (!localMode) return []
    return withLocalLock((data) => ({
      value: Object.values(data.checkouts)
        .filter((order) => order.status === 'success' && !order.shopifyOrderId)
        .slice(0, safeLimit),
    }))
  }
  const result = await pool.query(`SELECT order_data
    FROM bm_payu_checkouts
    WHERE status = 'success' AND order_data->>'shopifyOrderId' IS NULL
    ORDER BY updated_at DESC
    LIMIT $1`, [safeLimit])
  return result.rows.map((row) => row.order_data)
}

export async function attachShopifyOrder(txnid, shopifyOrder) {
  if (!txnid || !shopifyOrder?.id) return false
  const patch = {
    shopifyOrderId: String(shopifyOrder.id),
    shopifyOrderNumber: shopifyOrder.name || shopifyOrder.order_number || '',
    shopifyOrderUrl: shopifyOrder.admin_graphql_api_id || '',
    shopifyOrderCreatedAt: new Date().toISOString(),
  }
  const pool = await database()
  if (!pool) {
    if (!localMode) return false
    return withLocalLock((data) => {
      const order = data.checkouts[txnid]
      if (!order) return { value: false }
      Object.assign(order, patch)
      return { changed: true, value: true }
    })
  }

  const result = await pool.query(
    `UPDATE bm_payu_checkouts
      SET order_data = order_data || $2::jsonb, updated_at = now()
      WHERE txnid = $1
      RETURNING txnid`,
    [txnid, JSON.stringify(patch)],
  )
  return result.rowCount > 0
}

export async function finishCheckout(txnid, confirmed) {
  const pool = await database()
  if (!pool) return withLocalLock((data) => {
    const order = data.checkouts[txnid]
    if (!order) return { value: false }
    if (order.status === 'success') return { value: false }
    order.status = confirmed ? 'success' : 'failure'
    if (order.coupon && data.claims[order.phone]?.txnid === txnid) {
      if (confirmed) data.claims[order.phone].status = 'used'
      else delete data.claims[order.phone]
    }
    return { changed: true, value: confirmed }
  })

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await client.query('SELECT phone, coupon, status FROM bm_payu_checkouts WHERE txnid = $1 FOR UPDATE', [txnid])
    const order = result.rows[0]
    if (!order || order.status === 'success') {
      await client.query('ROLLBACK')
      return false
    }
    await client.query(`UPDATE bm_payu_checkouts SET status = $2, updated_at = now() WHERE txnid = $1`, [txnid, confirmed ? 'success' : 'failure'])
    if (order.coupon) {
      if (confirmed) await client.query(`UPDATE bm_payu_coupon_claims SET status = 'used' WHERE phone = $1 AND txnid = $2`, [order.phone, txnid])
      else await client.query(`DELETE FROM bm_payu_coupon_claims WHERE phone = $1 AND txnid = $2 AND status = 'pending'`, [order.phone, txnid])
    }
    await client.query('COMMIT')
    return confirmed
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
