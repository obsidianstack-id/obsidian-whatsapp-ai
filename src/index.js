require('dotenv').config();

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const { db, getSettings, setSettings, audit } = require('./database/db');
const {
  startWhatsApp,
  getWhatsAppStatus,
  sendManual,
  setConversationMode,
} = require('./services/whatsapp.service');
const { verifyWebhook, markOrderPaid, isMidtrans, midtransServerKey, verifyMidtransSignature, getMidtransTransactionStatus, createMidtransPayment } = require('./services/payment.service');
const rentalService = require('./services/rental.service');

if (!process.env.ADMIN_PASSWORD || !process.env.SESSION_SECRET) {
  console.error('ADMIN_PASSWORD dan SESSION_SECRET wajib diatur pada environment.');
  process.exit(1);
}
if (Buffer.byteLength(process.env.SESSION_SECRET) < 32) {
  console.error('SESSION_SECRET minimal 32 byte. Buat secret acak yang lebih panjang.');
  process.exit(1);
}

const app = express();
const port = Number(process.env.PORT || 8080);
const publicDirectory = path.join(__dirname, '..', 'public');
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

app.disable('x-powered-by');
app.set('trust proxy', 1); // Railway terminates HTTPS in front of the app.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));
const uploadDirectory = path.resolve(process.env.STORAGE_DIR || './storage', 'uploads', 'rental');
fs.mkdirSync(uploadDirectory, { recursive: true });

function createToken(value, expiresAt) {
  const payload = Buffer.from(JSON.stringify({ value, expiresAt })).toString('base64url');
  const signature = crypto
    .createHmac('sha256', process.env.SESSION_SECRET)
    .update(payload)
    .digest('base64url');
  return `${payload}.${signature}`;
}

function isValidToken(token) {
  try {
    const [payload, signature] = String(token || '').split('.');
    if (!payload || !signature) return false;

    const expected = crypto
      .createHmac('sha256', process.env.SESSION_SECRET)
      .update(payload)
      .digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      return false;
    }

    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return decoded.value === 'admin' && decoded.expiresAt > Date.now();
  } catch {
    return false;
  }
}

function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!isValidToken(token)) {
    return res.status(401).json({ error: 'Sesi tidak valid atau sudah berakhir. Silakan login kembali.' });
  }
  return next();
}

function getClientKey(req) {
  // Do not trust forwarded IP headers unless Railway's trusted-proxy configuration is explicit.
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function validateId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function safeSettings(settings) {
  return {
    ...settings,
    openrouter_api_key: settings.openrouter_api_key ? '•••••••• (tersimpan)' : '',
    payment_api_key: settings.payment_api_key ? '•••••••• (tersimpan)' : '',
    payment_webhook_secret: settings.payment_webhook_secret ? '•••••••• (tersimpan)' : '',
  };
}

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'obsidian-whatsapp-ai', whatsapp: getWhatsAppStatus().status });
});

app.post('/api/login', (req, res) => {
  const clientKey = getClientKey(req);
  const now = Date.now();
  const attempt = loginAttempts.get(clientKey);
  if (attempt && now - attempt.startedAt < LOGIN_WINDOW_MS && attempt.count >= LOGIN_MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'Terlalu banyak percobaan login. Coba lagi 15 menit kemudian.' });
  }
  if (!attempt || now - attempt.startedAt >= LOGIN_WINDOW_MS) {
    loginAttempts.set(clientKey, { startedAt: now, count: 0 });
  }

  const provided = Buffer.from(String(req.body.password || ''));
  const expected = Buffer.from(process.env.ADMIN_PASSWORD);
  const passwordMatches = provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
  if (!passwordMatches) {
    loginAttempts.get(clientKey).count += 1;
    return res.status(401).json({ error: 'Password salah.' });
  }

  loginAttempts.delete(clientKey);
  const token = createToken('admin', Date.now() + 12 * 60 * 60 * 1000);
  audit('admin', 'login');
  return res.json({ token, expiresIn: 43200 });
});

app.post('/api/logout', requireAuth, (req, res) => res.json({ ok: true }));

app.get('/api/bootstrap', requireAuth, (req, res) => {
  const settings = getSettings();
  const products = db.prepare('SELECT * FROM products ORDER BY id DESC').all();
  const orders = db
    .prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 100')
    .all()
    .map((order) => ({ ...order, items: JSON.parse(order.items_json) }));
  const conversations = db
    .prepare(
      `SELECT c.*, cu.name, cu.notes,
        (SELECT body FROM messages m WHERE m.wa_id = c.wa_id ORDER BY id DESC LIMIT 1) AS last_message,
        (SELECT created_at FROM messages m WHERE m.wa_id = c.wa_id ORDER BY id DESC LIMIT 1) AS last_message_at
       FROM conversations c
       LEFT JOIN customers cu ON cu.wa_id = c.wa_id
       ORDER BY c.updated_at DESC`,
    )
    .all();
  const messages = db.prepare('SELECT * FROM messages ORDER BY id DESC LIMIT 300').all().reverse();
  const count = (sql) => db.prepare(sql).get().n;
  const stats = {
    products: products.length,
    customers: count('SELECT COUNT(*) AS n FROM customers'),
    conversations: conversations.length,
    orders: orders.length,
    paid: count("SELECT COUNT(*) AS n FROM orders WHERE payment_status = 'paid'"),
    revenue: count("SELECT COALESCE(SUM(total), 0) AS n FROM orders WHERE payment_status = 'paid'"),
  };

  res.json({
    settings: safeSettings(settings),
    products,
    orders,
    rentalAccounts: rentalService.listAccounts(),
    rentals: rentalService.listRentals(),
    nightBookings: rentalService.listNightBookings(),
    rentalBlacklist: rentalService.listBlacklist(),
    rentalPrices: rentalService.getRentalPrices(),
    conversations,
    messages,
    stats,
    whatsapp: getWhatsAppStatus(),
    audit: db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 30').all(),
  });
});

const ALLOWED_SETTINGS = new Set([
  'business_name', 'business_description', 'business_hours', 'welcome_message', 'menu_text',
  'admin_whatsapp', 'ai_enabled', 'ai_provider', 'openrouter_api_key', 'openrouter_model',
  'openrouter_site_url', 'openrouter_app_name', 'ai_system_prompt', 'static_qris_image',
  'static_qris_instructions', 'payment_provider_name', 'payment_create_url', 'payment_status_url',
  'payment_api_key', 'payment_merchant_id', 'payment_mode', 'payment_dynamic_enabled',
  'payment_webhook_secret', 'payment_expiry_minutes', 'currency', 'human_handover_message',
  'auto_reply_enabled', 'sticker_spam_enabled', 'rental_verification_message', 'rental_hourly_payment_message', 'rental_payment_hold_minutes', 'rental_issue_report_minutes', 'rental_night_start', 'rental_night_end', 'rental_intro_message', 'rental_booking_enabled', 'rental_booking_dp', 'rental_night_price',
]);
const SECRET_SETTINGS = new Set(['openrouter_api_key', 'payment_api_key', 'payment_webhook_secret']);

app.put('/api/settings', requireAuth, (req, res) => {
  const values = {};
  for (const [key, value] of Object.entries(req.body || {})) {
    if (!ALLOWED_SETTINGS.has(key)) continue;
    if (typeof value === 'string' && (value.includes('\u0000') || value.length > 20_000)) {
      return res.status(400).json({ error: `Nilai pengaturan ${key} tidak valid atau terlalu panjang.` });
    }
    if (SECRET_SETTINGS.has(key)) {
      const currentSecret = getSettings()[key] || '';
      if (String(value).startsWith('••••') || (String(value) === '' && currentSecret)) continue;
    }
    values[key] = value;
  }

  setSettings(values);
  audit('admin', 'settings.updated', Object.keys(values).join(','));
  return res.json({ ok: true });
});

app.post('/api/payments/test', requireAuth, async (req, res) => {
  const settings = getSettings();
  if (!isMidtrans(settings)) return res.status(400).json({ error: 'Pilih nama provider Midtrans terlebih dahulu.' });
  if (!midtransServerKey(settings)) return res.status(400).json({ error: 'Server Key Midtrans belum disimpan pada Railway atau Panel Admin.' });
  try {
    const testCode = `OBSIDIAN-TEST-${Date.now()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    const data = await createMidtransPayment({ order_code: testCode, total: 1000, wa_id: '' }, settings);
    audit('admin', 'midtrans.configuration.tested', `mode=${settings.payment_mode || 'sandbox'} code=${testCode}`);
    return res.json({ ok: true, provider: 'Midtrans', mode: settings.payment_mode || 'sandbox', message: 'Server Key diterima Midtrans; Snap transaction berhasil dibuat.', redirect_url: data.redirect_url });
  } catch (error) {
    return res.status(502).json({ error: `Tes Midtrans gagal: ${error.message}` });
  }
});

app.get('/api/openrouter/models', requireAuth, async (req, res) => {
  const settings = getSettings();
  if (!settings.openrouter_api_key) {
    return res.status(400).json({ error: 'Simpan API Key OpenRouter terlebih dahulu.' });
  }

  try {
    const response = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: `Bearer ${settings.openrouter_api_key}` },
      signal: AbortSignal.timeout(15_000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return res.status(response.status).json({ error: data?.error?.message || 'Gagal mengambil model.' });
    }
    const models = (data.data || [])
      .filter((model) => model.id.includes(':free') || Number(model.pricing?.prompt) === 0)
      .map((model) => ({
        id: model.id,
        name: model.name,
        context_length: model.context_length,
        pricing: model.pricing,
      }));
    return res.json({ models });
  } catch (error) {
    return res.status(502).json({ error: error.message || 'OpenRouter tidak dapat dijangkau.' });
  }
});

app.post('/api/whatsapp/start', requireAuth, (req, res) => {
  startWhatsApp().catch((error) => console.error('WhatsApp startup error:', error));
  return res.json({ ok: true });
});
app.get('/api/whatsapp/status', requireAuth, (req, res) => res.json(getWhatsAppStatus()));

app.post('/api/products', requireAuth, (req, res) => {
  const product = req.body || {};
  const name = String(product.name || '').trim();
  if (!name || name.length > 200) return res.status(400).json({ error: 'Nama produk wajib diisi (maksimal 200 karakter).' });

  const price = Math.max(0, Math.round(Number(product.price) || 0));
  const promoPrice = product.promo_price == null || product.promo_price === ''
    ? null
    : Math.max(0, Math.round(Number(product.promo_price) || 0));
  const stock = product.unlimited_stock ? null : Math.max(0, Math.round(Number(product.stock) || 0));

  try {
    const result = db.prepare(
      `INSERT INTO products
       (sku, name, category, description, price, promo_price, stock, unlimited_stock, image_url, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      product.sku || null, name, product.category || '', product.description || '', price,
      promoPrice, stock, product.unlimited_stock ? 1 : 0, product.image_url || '',
      product.active === false ? 0 : 1,
    );
    audit('admin', 'product.created', name);
    return res.json({ ok: true, id: result.lastInsertRowid });
  } catch (error) {
    return res.status(400).json({ error: String(error.message).includes('UNIQUE') ? 'SKU sudah digunakan.' : error.message });
  }
});

app.put('/api/products/:id', requireAuth, (req, res) => {
  const id = validateId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID produk tidak valid.' });
  const product = req.body || {};
  const name = String(product.name || '').trim();
  if (!name || name.length > 200) return res.status(400).json({ error: 'Nama produk wajib diisi (maksimal 200 karakter).' });

  try {
    const result = db.prepare(
      `UPDATE products SET sku = ?, name = ?, category = ?, description = ?, price = ?,
       promo_price = ?, stock = ?, unlimited_stock = ?, image_url = ?, active = ?,
       updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    ).run(
      product.sku || null, name, product.category || '', product.description || '',
      Math.max(0, Math.round(Number(product.price) || 0)),
      product.promo_price == null || product.promo_price === '' ? null : Math.max(0, Math.round(Number(product.promo_price) || 0)),
      product.unlimited_stock ? null : Math.max(0, Math.round(Number(product.stock) || 0)),
      product.unlimited_stock ? 1 : 0, product.image_url || '', product.active === false ? 0 : 1, id,
    );
    if (!result.changes) return res.status(404).json({ error: 'Produk tidak ditemukan.' });
    audit('admin', 'product.updated', name);
    return res.json({ ok: true });
  } catch (error) {
    return res.status(400).json({ error: String(error.message).includes('UNIQUE') ? 'SKU sudah digunakan.' : error.message });
  }
});

app.delete('/api/products/:id', requireAuth, (req, res) => {
  const id = validateId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID produk tidak valid.' });
  const result = db.prepare('DELETE FROM products WHERE id = ?').run(id);
  if (!result.changes) return res.status(404).json({ error: 'Produk tidak ditemukan.' });
  audit('admin', 'product.deleted', id);
  return res.json({ ok: true });
});

app.post('/api/rentals/blacklist', requireAuth, (req, res) => {
  try {
    rentalService.addBlacklist(req.body.wa_id, req.body.reason, req.body.account_code || '', 'admin');
    return res.json({ ok: true });
  } catch (error) { return res.status(400).json({ error: error.message }); }
});
app.delete('/api/rentals/blacklist/:waId', requireAuth, (req, res) => {
  try { rentalService.removeBlacklist(decodeURIComponent(req.params.waId), 'admin'); return res.json({ ok: true }); }
  catch (error) { return res.status(400).json({ error: error.message }); }
});

app.post('/api/rentals/photos', requireAuth, (req, res) => {
  try {
    const { data, filename = 'rental-photo' } = req.body || {};
    const match = String(data || '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!match) return res.status(400).json({ error: 'Format foto harus JPG, PNG, atau WebP.' });
    const buffer = Buffer.from(match[2], 'base64');
    if (!buffer.length || buffer.length > 5 * 1024 * 1024) return res.status(400).json({ error: 'Ukuran foto maksimal 5 MB.' });
    const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[match[1]];
    const safeName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
    fs.writeFileSync(path.join(uploadDirectory, safeName), buffer, { flag: 'wx' });
    const base = String(process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    audit('admin', 'rental.photo.uploaded', String(filename).slice(0,100));
    return res.json({ ok: true, url: `${base}/uploads/rental/${safeName}` });
  } catch (error) { return res.status(400).json({ error: `Upload foto gagal: ${error.message}` }); }
});

app.post('/api/rentals/accounts', requireAuth, (req, res) => {
  try { const account = rentalService.createAccount(req.body || {}); return res.json({ ok: true, id: account.id }); }
  catch (error) { return res.status(400).json({ error: error.message }); }
});
app.put('/api/rentals/accounts/:id', requireAuth, (req, res) => {
  const id = validateId(req.params.id); if (!id) return res.status(400).json({ error: 'ID akun tidak valid.' });
  try { rentalService.updateAccount(id, req.body || {}); return res.json({ ok: true }); }
  catch (error) { return res.status(400).json({ error: error.message }); }
});
app.delete('/api/rentals/accounts/:id', requireAuth, (req, res) => {
  const id = validateId(req.params.id); if (!id) return res.status(400).json({ error: 'ID akun tidak valid.' });
  try { rentalService.deleteAccount(id); return res.json({ ok: true }); }
  catch (error) { return res.status(400).json({ error: error.message }); }
});
app.post('/api/rentals/accounts/:id/maintenance', requireAuth, (req, res) => {
  const id = validateId(req.params.id); if (!id) return res.status(400).json({ error: 'ID akun tidak valid.' });
  try { rentalService.setMaintenance(id, Boolean(req.body.enabled)); return res.json({ ok: true }); }
  catch (error) { return res.status(400).json({ error: error.message }); }
});
app.post('/api/rentals/prices', requireAuth, (req, res) => {
  try { rentalService.upsertPrice(req.body || {}); return res.json({ ok: true }); }
  catch (error) { return res.status(400).json({ error: error.message }); }
});
app.post('/api/rentals/:id/paid', requireAuth, (req, res) => {
  const id = validateId(req.params.id); if (!id) return res.status(400).json({ error: 'ID rental tidak valid.' });
  const rental = db.prepare('SELECT rental_code FROM rental_sessions WHERE id=?').get(id);
  if (!rental) return res.status(404).json({ error: 'Rental tidak ditemukan.' });
  try { rentalService.markRentalPaid(rental.rental_code, 'manual-admin-verified'); audit('admin','rental.payment.verified',rental.rental_code); return res.json({ ok: true }); }
  catch (error) { return res.status(400).json({ error: error.message }); }
});
app.post('/api/rentals/:id/resolve', requireAuth, (req, res) => {
  const id = validateId(req.params.id); if (!id) return res.status(400).json({ error: 'ID rental tidak valid.' });
  try { rentalService.resolveIssue(id, req.body.note || 'Akun sudah diperiksa admin dan dinyatakan normal.'); return res.json({ ok: true }); }
  catch (error) { return res.status(400).json({ error: error.message }); }
});

app.post('/api/orders/:id/paid', requireAuth, (req, res) => {
  const id = validateId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID pesanan tidak valid.' });
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan.' });

  try {
    markOrderPaid(order.order_code, 'admin-verified');
    audit('admin', 'payment.manual_verified', order.order_code);
    return res.json({ ok: true });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.put('/api/orders/:id/status', requireAuth, (req, res) => {
  const id = validateId(req.params.id);
  const allowedStatuses = ['new', 'processing', 'ready', 'completed', 'cancelled'];
  if (!id) return res.status(400).json({ error: 'ID pesanan tidak valid.' });
  if (!allowedStatuses.includes(req.body.status)) return res.status(400).json({ error: 'Status tidak valid.' });

  const result = db.prepare(
    'UPDATE orders SET order_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
  ).run(req.body.status, id);
  if (!result.changes) return res.status(404).json({ error: 'Pesanan tidak ditemukan.' });
  audit('admin', 'order.status_updated', `${id}:${req.body.status}`);
  return res.json({ ok: true });
});

app.post('/api/conversations/:waId/reply', requireAuth, async (req, res) => {
  const waId = decodeURIComponent(req.params.waId);
  const message = String(req.body.text || '').trim();
  if (!message) return res.status(400).json({ error: 'Pesan kosong.' });
  if (message.length > 10_000) return res.status(400).json({ error: 'Pesan terlalu panjang.' });

  try {
    await sendManual(waId, message);
    audit('admin', 'conversation.reply', waId);
    return res.json({ ok: true });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.put('/api/conversations/:waId/mode', requireAuth, (req, res) => {
  const waId = decodeURIComponent(req.params.waId);
  try {
    setConversationMode(waId, req.body.mode);
    audit('admin', 'conversation.mode', `${waId}:${req.body.mode}`);
    return res.json({ ok: true });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.post('/api/webhooks/payment', async (req, res) => {
  const body = req.body || {};
  const settings = getSettings();
  const midtrans = isMidtrans(settings);
  if (midtrans) {
    if (!verifyMidtransSignature(body, midtransServerKey(settings))) return res.status(401).json({ error: 'Signature Midtrans tidak valid.' });
  } else if (!verifyWebhook(req)) {
    return res.status(401).json({ error: 'Webhook secret tidak valid.' });
  }

  const orderCode = String(body.order_id || body.external_id || body.reference_id || '');
  if (!orderCode) return res.status(400).json({ error: 'order_id tidak ditemukan.' });
  let status = String(body.status || body.payment_status || body.transaction_status || '').toLowerCase();
  let reference = String(body.transaction_id || body.reference || body.id || '');
  if (midtrans) {
    try {
      const verified = await getMidtransTransactionStatus(orderCode, settings);
      const expectedAmount = orderCode.startsWith('RNT-')
        ? db.prepare('SELECT price AS total, payment_status FROM rental_sessions WHERE rental_code=?').get(orderCode)
        : orderCode.startsWith('NGT-') ? db.prepare(`SELECT CASE WHEN dp_order_code=? THEN dp_amount ELSE balance_amount END AS total, CASE WHEN dp_order_code=? THEN payment_status ELSE status END AS payment_status FROM rental_night_bookings WHERE dp_order_code=? OR balance_order_code=?`).get(orderCode,orderCode,orderCode,orderCode)
        : db.prepare('SELECT total, payment_status FROM orders WHERE order_code=?').get(orderCode);
      if (!expectedAmount) return res.status(404).json({ error: 'Transaksi tidak ditemukan.' });
      if (verified.order_id && String(verified.order_id) !== orderCode) return res.status(400).json({ error: 'Kode transaksi Midtrans tidak cocok.' });
      const actualAmount = Number(verified.gross_amount);
      if (!Number.isFinite(actualAmount) || actualAmount !== Number(expectedAmount.total)) {
        audit('system', 'midtrans.amount_mismatch', `${orderCode} expected=${expectedAmount.total} actual=${verified.gross_amount}`);
        return res.status(400).json({ error: 'Nominal transaksi Midtrans tidak cocok dengan pesanan.' });
      }
      if (expectedAmount.payment_status === 'paid' || (orderCode.startsWith('NGT-') && ['dp_paid','active','completed'].includes(String(expectedAmount.payment_status)))) return res.json({ ok: true, duplicate: true });
      status = String(verified.transaction_status || '').toLowerCase();
      reference = String(verified.transaction_id || reference);
      if (!(['settlement', 'capture'].includes(status) && (!verified.fraud_status || String(verified.fraud_status).toLowerCase() === 'accept'))) {
        if (['expire', 'cancel', 'deny', 'failure'].includes(status)) {
          if (orderCode.startsWith('RNT-')) {
            rentalService.cancelPendingRental(orderCode, status === 'expire' ? 'expired' : 'failed');
          } else if (orderCode.startsWith('NGT-')) {
            db.prepare(`UPDATE rental_night_bookings SET status=CASE WHEN dp_order_code=? THEN 'cancelled' ELSE status END, payment_status=CASE WHEN dp_order_code=? THEN ? ELSE payment_status END, balance_order_code=CASE WHEN balance_order_code=? AND status='awaiting_balance' THEN '' ELSE balance_order_code END, balance_url=CASE WHEN balance_order_code=? AND status='awaiting_balance' THEN '' ELSE balance_url END, updated_at=CURRENT_TIMESTAMP WHERE dp_order_code=? OR balance_order_code=?`).run(orderCode,orderCode,status==='expire'?'dp_expired':'dp_failed',orderCode,orderCode,orderCode);
          } else {
            db.prepare("UPDATE orders SET payment_status=?, updated_at=CURRENT_TIMESTAMP WHERE order_code=? AND payment_status='pending'").run(status === 'expire' ? 'expired' : 'failed', orderCode);
          }
        }
        return res.json({ ok: true, status });
      }
    } catch (error) {
      console.error('Midtrans notification verification failed:', error.message);
      return res.status(502).json({ error: 'Gagal memverifikasi status transaksi ke Midtrans.' });
    }
  }

  if (['paid', 'success', 'settlement', 'capture', 'completed'].includes(status)) {
    try {
      if (orderCode.startsWith('RNT-')) rentalService.markRentalPaid(orderCode, reference || orderCode);
      else if (orderCode.startsWith('NGT-')) rentalService.markNightPaid(orderCode, reference || orderCode);
      else {
        const order = markOrderPaid(orderCode, reference);
        const { sendText } = require('./services/whatsapp.service');
        sendText(order.wa_id, `✅ Pembayaran untuk pesanan *${orderCode}* telah terverifikasi. Terima kasih!`)
          .catch((error) => console.error('Payment confirmation message failed:', error.message));
      }
      return res.json({ ok: true });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  }
  if (['expired', 'expire'].includes(status)) {
    if (orderCode.startsWith('RNT-')) rentalService.cancelPendingRental(orderCode, 'expired');
    else if (orderCode.startsWith('NGT-')) db.prepare(`UPDATE rental_night_bookings SET status=CASE WHEN dp_order_code=? THEN 'cancelled' ELSE status END,payment_status=CASE WHEN dp_order_code=? THEN 'dp_expired' ELSE payment_status END,balance_order_code=CASE WHEN balance_order_code=? AND status='awaiting_balance' THEN '' ELSE balance_order_code END,balance_url=CASE WHEN balance_order_code=? AND status='awaiting_balance' THEN '' ELSE balance_url END,updated_at=CURRENT_TIMESTAMP WHERE dp_order_code=? OR balance_order_code=?`).run(orderCode,orderCode,orderCode,orderCode,orderCode,orderCode);
    else db.prepare("UPDATE orders SET payment_status='expired', updated_at=CURRENT_TIMESTAMP WHERE order_code=? AND payment_status='pending'").run(orderCode);
  }
  if (['failed', 'deny', 'cancelled', 'canceled', 'failure', 'cancel'].includes(status)) {
    if (orderCode.startsWith('RNT-')) rentalService.cancelPendingRental(orderCode, 'failed');
    else if (orderCode.startsWith('NGT-')) db.prepare(`UPDATE rental_night_bookings SET status=CASE WHEN dp_order_code=? THEN 'cancelled' ELSE status END,payment_status=CASE WHEN dp_order_code=? THEN 'dp_failed' ELSE payment_status END,balance_order_code=CASE WHEN balance_order_code=? AND status='awaiting_balance' THEN '' ELSE balance_order_code END,balance_url=CASE WHEN balance_order_code=? AND status='awaiting_balance' THEN '' ELSE balance_url END,updated_at=CURRENT_TIMESTAMP WHERE dp_order_code=? OR balance_order_code=?`).run(orderCode,orderCode,orderCode,orderCode,orderCode,orderCode);
    else db.prepare("UPDATE orders SET payment_status='failed', updated_at=CURRENT_TIMESTAMP WHERE order_code=? AND payment_status='pending'").run(orderCode);
  }
  return res.json({ ok: true, status });
});

app.use('/uploads/rental', express.static(uploadDirectory, { index: false, maxAge: '7d', dotfiles: 'deny' }));
app.use(express.static(publicDirectory, { index: false, maxAge: '1h' }));
app.get('*', (req, res) => res.sendFile(path.join(publicDirectory, 'index.html')));

app.listen(port, '0.0.0.0', () => {
  const storageRoot = path.resolve(process.env.STORAGE_DIR || './storage');
  const databaseRoot = path.resolve(process.env.DATA_DIR || path.join(storageRoot, 'data'));
  const whatsappAuthRoot = path.resolve(process.env.AUTH_DIR || path.join(storageRoot, 'auth'));
  const rentalUploadsRoot = path.resolve(storageRoot, 'uploads', 'rental');
  console.log(`Kwenzy | Utama listening on port ${port}`);
  console.log(`[PERSISTENCE] STORAGE_DIR=${storageRoot}`);
  console.log(`[PERSISTENCE] SQLite database=${path.join(databaseRoot, 'obsidian.sqlite')}`);
  console.log(`[PERSISTENCE] WhatsApp session=${whatsappAuthRoot}`);
  console.log(`[PERSISTENCE] Rental uploads=${rentalUploadsRoot}`);
  if (process.env.RAILWAY_ENVIRONMENT && storageRoot !== '/app/storage') {
    console.warn('[PERSISTENCE WARNING] Railway detected but STORAGE_DIR is not /app/storage. Confirm that STORAGE_DIR and the Persistent Volume mount path match, or data/session may be lost on redeploy.');
  }
  if (process.env.DATA_DIR || process.env.AUTH_DIR) {
    console.warn('[PERSISTENCE WARNING] DATA_DIR/AUTH_DIR override STORAGE_DIR defaults. Confirm both paths are on persistent storage.');
  }
});
