require('dotenv').config();

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const { db, getSettings, setSettings, audit } = require('./database/db');
const {
  startWhatsApp,
  getWhatsAppStatus,
  sendManual,
  setConversationMode,
} = require('./services/whatsapp.service');
const { verifyWebhook, markOrderPaid } = require('./services/payment.service');

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
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));

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
  'auto_reply_enabled', 'sticker_spam_enabled',
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

app.post('/api/webhooks/payment', (req, res) => {
  if (!verifyWebhook(req)) return res.status(401).json({ error: 'Webhook secret tidak valid.' });

  const body = req.body || {};
  const status = String(body.status || body.payment_status || body.transaction_status || '').toLowerCase();
  const orderCode = body.order_id || body.external_id || body.reference_id;
  const reference = body.reference || body.transaction_id || body.id || '';
  if (!orderCode) return res.status(400).json({ error: 'order_id tidak ditemukan.' });

  if (['paid', 'success', 'settlement', 'capture', 'completed'].includes(status)) {
    try {
      const order = markOrderPaid(orderCode, String(reference));
      const { sendText } = require('./services/whatsapp.service');
      sendText(order.wa_id, `✅ Pembayaran untuk pesanan *${orderCode}* telah terverifikasi. Terima kasih!`)
        .catch((error) => console.error('Payment confirmation message failed:', error.message));
      return res.json({ ok: true });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  }

  if (['expired', 'expire'].includes(status)) {
    db.prepare(
      "UPDATE orders SET payment_status = 'expired', updated_at = CURRENT_TIMESTAMP WHERE order_code = ? AND payment_status = 'pending'",
    ).run(orderCode);
  }
  if (['failed', 'deny', 'cancelled', 'canceled'].includes(status)) {
    db.prepare(
      "UPDATE orders SET payment_status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE order_code = ? AND payment_status = 'pending'",
    ).run(orderCode);
  }
  return res.json({ ok: true, received: true });
});

app.use(express.static(publicDirectory, { index: false, maxAge: '1h' }));
app.get('*', (req, res) => res.sendFile(path.join(publicDirectory, 'index.html')));

app.listen(port, '0.0.0.0', () => {
  console.log(`Obsidian Stack listening on port ${port}`);
});
