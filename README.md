# Obsidian Stack — WhatsApp AI Commerce

Single-business WhatsApp AI customer service with admin dashboard, product/inventory management, rental accounts, orders, OpenRouter configuration, static QRIS, generic provider support, and a Midtrans Snap integration for Sandbox/Production.

## Important scope notes

- Midtrans Snap integration uses the official Snap transaction endpoint, stores the redirect URL for product orders and rentals, verifies notification signatures, and fetches transaction status from Midtrans before fulfilling a payment. Configure the Midtrans notification URL to `https://YOUR-DOMAIN/api/webhooks/payment`. Sandbox is the default; never use production keys while testing. Non-Midtrans providers still use the generic adapter and require provider-specific validation.
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

## Midtrans Sandbox setup

1. In Admin Panel → **Pembayaran**, set **Nama provider** to `Midtrans` and **Mode** to `Sandbox / test`.
2. Paste the Midtrans **Server Key** from the Sandbox dashboard into **API Key / Server Key**, then save. The panel masks the stored key; a blank key field on refresh is intentional and does not erase the stored key.
3. You may instead set `MIDTRANS_SERVER_KEY`, `MIDTRANS_CLIENT_KEY`, and `MIDTRANS_IS_PRODUCTION=false` in Railway Variables; the Server Key environment variable takes precedence over the panel key. In the panel set **Nama provider** to `Midtrans`, enable **pembayaran dinamis**, save, then click **Periksa kelengkapan** to run a real Sandbox Snap transaction creation test (Rp1.000). This creates a test transaction in Midtrans Sandbox but does not create a customer order in the app.
4. Ensure `PUBLIC_BASE_URL` is the public HTTPS Railway URL. The app sends `X-Override-Notification` to `/api/webhooks/payment` when creating Snap transactions. If your Midtrans account configuration overrides notification routing, also set the Notification URL in Midtrans Dashboard to `https://YOUR-DOMAIN/api/webhooks/payment`.
5. In WhatsApp, create a rental and use the short format `BAYARBOS FF-1 A7` with the two-character unique code shown in the reservation. The legacy format `BAYAR RENTAL RNT-... DINAMIS` remains supported. The bot should return the Snap payment URL. Complete a Sandbox payment and verify that the panel marks it paid, sends credentials only after verified status, and starts the rental timer.
6. Do not switch to Production until the Sandbox flow and webhook have been tested end-to-end. Use the Production Server Key only after you intentionally select Production mode.

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

- `LIST` atau `RENTAL` — melihat akun tersedia dan tarif.
- `CEK FF-1` — melihat catatan spesifikasi akun dan hingga 10 foto URL yang diatur admin.
- `SEWA FF-1 60` atau `SEWA FF-1 1JAM` — meminta sewa akun selama 60 menit. Ganti kode dan durasi sesuai inventaris/tarif admin.
- `BAYARBOS FF-1 A7` — meminta tagihan untuk reservasi yang cocok dengan nomor pengirim, kode akun, dan kode unik 2 karakter. Kode unik bukan kode pembayaran Midtrans; status lunas tetap diverifikasi oleh Midtrans.
- `BAYAR RENTAL RNT-... STATIS` — menampilkan instruksi QRIS statis jika admin sudah mengatur QRIS.
- `BAYAR RENTAL RNT-... DINAMIS` — meminta tagihan melalui adapter pembayaran dinamis yang sudah dikonfigurasi.
- `AKUN TIDAK BISA DILOGINKAN` — menjeda timer sewa aktif, menandai akun bermasalah, dan mengirim notifikasi ke nomor admin yang disimpan di Pengaturan bisnis.
- Sebelum order, pelanggan harus mengirim share lokasi WhatsApp dan video wajah. Lokasi diteruskan dengan format `SHARELOK, NOMOR_BUYER`; video diteruskan dengan `VIDEO_MUKA, NOMOR_BUYER`. Admin tetap perlu memeriksa isi video secara manual.
- Video yang dikirim dalam dua jam setelah sesi selesai diteruskan sebagai `REKAMAN_LOGOUT, NOMOR_BUYER`.
- Blacklist dikelola melalui form Blacklist di panel Rental Game; nomor yang diblokir tidak bisa membuat reservasi baru.
- Foto spesifikasi akun dapat diatur di form inventaris sebagai maksimal 10 URL gambar publik, satu URL per baris.

Alur penting:

- Reservasi yang langsung mendapat akun mengunci akun selama batas pembayaran (default 20 menit). Jika tidak terbayar, reservasi kedaluwarsa dan antrean berikutnya dipromosikan.
- Akun yang sudah dipesan/aktif tidak dapat diberikan ke penyewa lain.
- Kredensial hanya dikirim setelah pembayaran ditandai terverifikasi oleh admin atau webhook provider dinamis yang valid.
- Timer sewa dimulai ketika pembayaran terverifikasi. Jika pelanggan melaporkan masalah login, timer dijeda; saat admin memilih **Akun normal**, durasi perbaikan ditambahkan ke akhir masa sewa.
- Lima menit sebelum masa sewa berakhir, bot mengirim pengingat perpanjangan. Pembuatan tagihan perpanjangan otomatis masih perlu pengembangan lanjutan.
- Setelah masa sewa berakhir, bot meminta logout dan rekaman layar; akun masuk status maintenance agar admin memeriksa sebelum mengaktifkannya kembali.
- Blacklist dikelola admin pada panel dan hanya digunakan untuk pelanggaran yang sudah diperiksa, bukan pelanggan yang sekadar bertanya.
- Setelah tiga menit, bot mengirim pengingat bahwa waktu sewa terus dihitung jika tidak ada laporan masalah.

**Penting:** QRIS statis tidak bisa mengonfirmasi pembayaran secara otomatis dari gambar atau pesan pelanggan; admin harus memverifikasi uang masuk. Otomatisasi pembayaran penuh memerlukan provider pembayaran nyata yang mendukung webhook, dan adapter API generik perlu disesuaikan serta diuji terhadap dokumentasi provider. Timer in-process ini membutuhkan satu replica Railway dan persistent volume di `DATA_DIR` serta `AUTH_DIR`; untuk reliabilitas produksi lebih tinggi, gunakan scheduler persisten/worker dan database terkelola.


## v1.8 rental panel update
- Added direct admin image uploads for rental account photos (JPG/PNG/WebP, max 5 MB each; up to 10 per account). Uploaded files are stored under `STORAGE_DIR/uploads/rental`; configure `STORAGE_DIR` on a Railway persistent volume and `PUBLIC_BASE_URL` for the public base URL.
- Added editable rental intro message, night-package start/end time, and booking DP settings.
- Rental `LIST` response now gives a step-by-step order and separate payment instruction using the short `BAYARBOS ACCOUNT CODE` format.
- Note: night-package inventory is currently presented from the available inventory; per-account hourly/night classification, automated DP booking, and paid extension transaction flow are not yet implemented in this release. The DP setting is configuration only and does not itself take deposits.
