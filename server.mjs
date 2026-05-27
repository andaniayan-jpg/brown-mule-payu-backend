import http from 'node:http'
import { handlePayuRequest } from './server/payu.mjs'

const PORT = process.env.PORT || 10000

const server = http.createServer(async (req, res) => {
  try {
    // Health check route for Render and browser testing
    if (req.url === '/healthz' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, service: 'brown-mule-payu' }))
      return
    }

    // PayU routes from server/payu.mjs
    const handled = await handlePayuRequest(req, res)

    if (!handled) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not found' }))
    }
  } catch (error) {
    console.error('Server error:', error)

    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Internal server error' }))
    } else {
      res.end()
    }
  }
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Brown Mule PayU backend running on port ${PORT}`)
})
