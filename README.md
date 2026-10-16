# Obsidian Stack — WhatsApp AI Commerce

Single-business WhatsApp AI customer service with admin dashboard, product/inventory management, orders, OpenRouter configuration, manual customer-service takeover, static QRIS settings and a generic dynamic-payment adapter contract.

## Important scope notes

- This is a runnable foundation, not a certified payment integration. Dynamic QRIS APIs differ by provider. The generic adapter in `src/services/payment.service.js` expects a provider endpoint that accepts `{order_id, amount, currency, customer_phone, callback_url}` and returns a reference plus optional payment URL/QR fields. Adapt it to the selected provider's official API before accepting real payments.
- The QRIS static setting accepts a public image URL. Local image upload is not included in this initial package.
- Admin manual payment verification is provided, but use it only after independently verifying funds.
- Baileys is an unofficial WhatsApp Web integration. It can break when WhatsApp changes its protocol. Consider official WhatsApp Business Platform for production use; verify its features and limitations for your use case.
- For phone-originated outgoing messages, sync behavior depends on events emitted by the linked WhatsApp session. Test it before relying on the dashboard as a complete shared inbox.
- Store `storage/` on persistent storage in production. By default, SQLite is stored in `storage/data/` and the WhatsApp session in `storage/auth/`. Do not commit `.env`, auth credentials, or the SQLite database.

## Requirements

- Node.js 20+
- npm
- A host that supports a persistent volume mounted at `storage/` (for example, a Railway volume)

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
3. Attach one persistent volume at `/app/storage` and set `STORAGE_DIR=/app/storage`. By default, the app stores the SQLite database in `/app/storage/data/` and WhatsApp session files in `/app/storage/auth/`. Remove old `DATA_DIR` and `AUTH_DIR` variables if you want the unified storage layout; explicit legacy overrides take precedence.
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
storage/
├── auth/                          # WhatsApp session (persistent volume)
└── data/                          # SQLite database (persistent volume)
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

## Rental akun game (v1.2)

Admin Panel memiliki menu **Rental Game** untuk menambahkan akun game, mengatur kode unik (misalnya `FF-1`, `ML-1`), kredensial login, tarif berdasarkan kode game dan durasi menit, batas pembayaran reservasi, serta jendela laporan gagal login.

Perintah WhatsApp:

- `RENTAL` — melihat akun tersedia dan tarif.
- `SEWA FF-1 60` — meminta sewa akun selama 60 menit. Ganti kode dan durasi sesuai inventaris/tarif admin.
- `BAYAR RENTAL RNT-... STATIS` — menampilkan instruksi QRIS statis jika admin sudah mengatur QRIS.
- `BAYAR RENTAL RNT-... DINAMIS` — meminta tagihan melalui adapter pembayaran dinamis yang sudah dikonfigurasi.
- `AKUN TIDAK BISA DILOGINKAN` — menjeda timer sewa aktif, menandai akun bermasalah, dan mengirim notifikasi ke nomor admin yang disimpan di Pengaturan bisnis.

Alur penting:

- Reservasi yang langsung mendapat akun mengunci akun selama batas pembayaran (default 20 menit). Jika tidak terbayar, reservasi kedaluwarsa dan antrean berikutnya dipromosikan.
- Akun yang sudah dipesan/aktif tidak dapat diberikan ke penyewa lain.
- Kredensial hanya dikirim setelah pembayaran ditandai terverifikasi oleh admin atau webhook provider dinamis yang valid.
- Timer sewa dimulai ketika pembayaran terverifikasi. Jika pelanggan melaporkan masalah login, timer dijeda; saat admin memilih **Akun normal**, durasi perbaikan ditambahkan ke akhir masa sewa.
- Setelah masa sewa berakhir, akun dilepas dan penyewa berikutnya di antrean diberi kesempatan.
- Setelah tiga menit, bot mengirim pengingat bahwa waktu sewa terus dihitung jika tidak ada laporan masalah.

**Penting:** QRIS statis tidak bisa mengonfirmasi pembayaran secara otomatis dari gambar atau pesan pelanggan; admin harus memverifikasi uang masuk. Otomatisasi pembayaran penuh memerlukan provider pembayaran nyata yang mendukung webhook, dan adapter API generik perlu disesuaikan serta diuji terhadap dokumentasi provider. Timer in-process ini membutuhkan satu replica Railway dan persistent volume di `DATA_DIR` serta `AUTH_DIR`; untuk reliabilitas produksi lebih tinggi, gunakan scheduler persisten/worker dan database terkelola.
