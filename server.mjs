import http from 'node:http'

const PORT = process.env.PORT || 10000

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, service: 'brown-mule-payu' }))
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'Not found' }))
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`)
})
