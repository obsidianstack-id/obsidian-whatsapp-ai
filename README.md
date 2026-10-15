# Obsidian Stack — WhatsApp AI Commerce

Single-business WhatsApp AI customer service with admin dashboard, product/inventory management, orders, OpenRouter configuration, manual customer-service takeover, static QRIS settings and a generic dynamic-payment adapter contract.

## Important scope notes

- This is a runnable foundation, not a certified payment integration. Dynamic QRIS APIs differ by provider. The generic adapter in `src/services/payment.service.js` expects a provider endpoint that accepts `{order_id, amount, currency, customer_phone, callback_url}` and returns a reference plus optional payment URL/QR fields. Adapt it to the selected provider's official API before accepting real payments.
- The QRIS static setting accepts a public image URL. Local image upload is not included in this initial package.
- Admin manual payment verification is provided, but use it only after independently verifying funds.
- Baileys is an unofficial WhatsApp Web integration. It can break when WhatsApp changes its protocol. Consider official WhatsApp Business Platform for production use; verify its features and limitations for your use case.
- For phone-originated outgoing messages, sync behavior depends on events emitted by the linked WhatsApp session. Test it before relying on the dashboard as a complete shared inbox.
- Store `auth/` and `data/` on persistent storage in production. Do not commit `.env`, auth credentials, or the SQLite database.

## Requirements

- Node.js 20+
- npm
- A host that supports persistent storage for `auth/` and `data/` (for example, a Railway volume)

## Local setup

1. Copy `.env.example` to `.env`.
2. Set `ADMIN_PASSWORD` and a long random `SESSION_SECRET`.
3. Run `npm install`.
4. Run `npm start`.
5. Open `http://localhost:8080`.
6. Log in with `ADMIN_PASSWORD`.
7. Configure OpenRouter from AI Settings, add products, then open WhatsApp and start the connection.
8. Scan the QR with WhatsApp Business → Linked devices → Link a device.

## Railway setup

1. Create a new Node.js service and upload these files or deploy the project using your chosen workflow; no GitHub integration is required by the app itself.
2. Set variables: `ADMIN_PASSWORD`, `SESSION_SECRET`, `PORT` (Railway normally injects this; do not hard-code a conflicting value), `PUBLIC_BASE_URL`, and optionally `PAYMENT_WEBHOOK_SECRET`.
3. Attach persistent storage at a path such as `/app/data` and `/app/auth`; set `DATA_DIR=/app/data` and `AUTH_DIR=/app/auth`.
4. Expose the HTTP service on its listening port so you can access the dashboard and QR page.
5. Keep HTTPS enabled. Never share QR codes or auth files.

## Security before production

- Use a unique strong admin password and long random session secret.
- Login attempts are throttled in memory per client IP. For multi-instance production, use a shared rate limiter/store because in-memory limits reset on restart.
- Use official provider-specific webhook signature verification. The generic `x-webhook-secret` is only a shared-secret baseline and may not meet provider requirements.
- Use provider-specific dynamic QRIS request/response mapping and verify status against provider API, not just a client-submitted webhook body.
- Restrict access to the admin panel (VPN/IP allow-list/SSO where possible), back up persistent storage, and use least-privilege access.
- Review privacy obligations before retaining customer messages and phone numbers.

## Source layout

```text
src/
├── index.js                       # Express app and API routes
├── database/
│   └── db.js                      # SQLite schema, settings, audit log
└── services/
    ├── ai.service.js              # OpenRouter chat completion
    ├── payment.service.js         # Orders and payment state
    └── whatsapp.service.js        # Baileys connection and message routing
public/
├── index.html                     # Admin Panel shell and styles
└── app.js                         # Admin Panel browser logic
auth/                              # WhatsApp session (persistent volume)
data/                              # SQLite database (persistent volume)
```

## Validation

Run `npm run check` to validate JavaScript syntax before deployment. This is a syntax check only; it does not replace integration testing against WhatsApp or a real payment provider.

## Current command flow

- `menu` / `halo`: show welcome and menu.
- `produk`: list active products.
- `PESAN <nomor_produk> <jumlah>`: create an order.
- `BAYAR <order_code>`: show static QRIS instructions.
- `BAYAR <order_code> DINAMIS`: request a dynamic payment via the configured adapter.
- `CS`: switch conversation to waiting-admin mode.

The admin can take over a conversation from the dashboard and return it to AI mode.
