services:
  - type: web
    name: brown-mule-payu-backend
    runtime: node
    plan: starter
    buildCommand: npm install
    startCommand: npm run serve
    healthCheckPath: /healthz
    envVars:
      - key: NODE_VERSION
        value: 22
      - key: PAYU_ENV
        value: production
      - key: PAYU_KEY
        sync: false
      - key: PAYU_SALT
        sync: false
      - key: PAYU_CLIENT_ID
        sync: false
      - key: PAYU_CLIENT_SECRET
        sync: false
      - key: PAYU_DEFAULT_PHONE
        value: 9924800451
      - key: PUBLIC_SITE_URL
        sync: false
