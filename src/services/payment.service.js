const crypto = require('crypto');
const { getSettings, db, audit } = require('../database/db');

function makeOrderCode() {
  const date = new Date();
  const day = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('');
  return `ORD-${day}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}
function midtransServerKey(settings = getSettings()) { return String(process.env.MIDTRANS_SERVER_KEY || settings.payment_api_key || '').trim(); }
function midtransIsProduction(settings = getSettings()) {
  if (process.env.MIDTRANS_IS_PRODUCTION != null) return String(process.env.MIDTRANS_IS_PRODUCTION).toLowerCase() === 'true';
  return String(settings.payment_mode || '').toLowerCase() === 'production';
}
function isMidtrans(settings = getSettings()) {
  return /midtrans/i.test(String(settings.payment_provider_name || '')) || Boolean(midtransServerKey(settings));
}
function midtransBase(settings = getSettings()) {
  return midtransIsProduction(settings) ? 'https://app.midtrans.com' : 'https://app.sandbox.midtrans.com';
}
function midtransApiBase(settings = getSettings()) {
  return midtransIsProduction(settings) ? 'https://api.midtrans.com' : 'https://api.sandbox.midtrans.com';
}
function midtransAuth(serverKey) {
  return `Basic ${Buffer.from(`${serverKey}:`).toString('base64')}`;
}
async function midtransFetch(url, serverKey, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: midtransAuth(serverKey),
      ...(options.headers || {}),
    },
    signal: options.signal || AbortSignal.timeout(20000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = Array.isArray(data.error_messages) ? data.error_messages.join('; ') : data.message;
    throw new Error(detail || `Midtrans merespons HTTP ${response.status}`);
  }
  return data;
}

function createOrder({ waId, customerName = '', items, paymentMethod = 'static' }) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('Pesanan tidak memiliki item.');
  const normalized = items.map((item) => {
    const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(Number(item.productId));
    const quantity = Math.max(1, Math.min(1000, Number(item.quantity) || 1));
    if (!product) throw new Error('Produk tidak ditemukan atau tidak aktif.');
    if (!product.unlimited_stock && (product.stock ?? 0) < quantity) throw new Error(`Stok ${product.name} tidak mencukupi.`);
    const unitPrice = product.promo_price != null ? product.promo_price : product.price;
    return { productId: product.id, sku: product.sku, name: product.name, quantity, unitPrice, lineTotal: unitPrice * quantity };
  });
  const subtotal = normalized.reduce((total, item) => total + item.lineTotal, 0);
  const orderCode = makeOrderCode();
  const expiryMinutes = Math.max(5, Number(getSettings().payment_expiry_minutes) || 15);
  const expiresAt = new Date(Date.now() + expiryMinutes * 60000).toISOString();
  db.prepare(`INSERT INTO orders (order_code, wa_id, customer_name, items_json, subtotal, total, payment_method, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(orderCode, waId, customerName, JSON.stringify(normalized), subtotal, subtotal, paymentMethod, expiresAt);
  audit(waId, 'order.created', `${orderCode} total=${subtotal}`);
  return db.prepare('SELECT * FROM orders WHERE order_code = ?').get(orderCode);
}

async function createMidtransPayment(order, settings = getSettings()) {
  const serverKey = midtransServerKey(settings);
  if (!serverKey) throw new Error('Midtrans Server Key belum diisi pada Panel Admin → Pembayaran.');
  const orderCode = String(order.order_code || order.rental_code || '');
  const existingPayment = orderCode.startsWith('RNT-')
    ? db.prepare('SELECT payment_url, payment_token, payment_method FROM rental_sessions WHERE rental_code=?').get(orderCode)
    : db.prepare('SELECT payment_url, payment_reference, payment_method FROM orders WHERE order_code=?').get(orderCode);
  if (existingPayment?.payment_url && existingPayment.payment_method === 'midtrans') return { payment_url: existingPayment.payment_url, redirect_url: existingPayment.payment_url, token: existingPayment.payment_token || '', reference: orderCode, provider: 'Midtrans', reused: true };
  const amount = Math.round(Number(order.total ?? order.price));
  if (!orderCode || orderCode.length > 50 || !/^[A-Za-z0-9._~-]+$/.test(orderCode)) throw new Error('Kode transaksi tidak valid untuk Midtrans.');
  if (!Number.isSafeInteger(amount) || amount < 1) throw new Error('Total pembayaran tidak valid.');
  const customerPhone = String(order.wa_id || '').replace(/@s\.whatsapp\.net$/i, '').replace(/\D/g, '');
  const payload = {
    transaction_details: { order_id: orderCode, gross_amount: amount },
    item_details: [{ id: orderCode.slice(0, 50), price: amount, quantity: 1, name: `Rental/Order ${orderCode}`.slice(0, 50) }],
    callbacks: { finish: process.env.PUBLIC_BASE_URL ? `${process.env.PUBLIC_BASE_URL.replace(/\/$/, '')}/payment/finish` : undefined },
  };
  if (customerPhone) payload.customer_details = { phone: customerPhone };
  const publicBase = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const notificationHeaders = publicBase ? { 'X-Override-Notification': `${publicBase}/api/webhooks/payment` } : {};
  const data = await midtransFetch(`${midtransBase(settings)}/snap/v1/transactions`, serverKey, { method: 'POST', headers: notificationHeaders, body: JSON.stringify(payload) });
  if (!data.token || !data.redirect_url) throw new Error('Respons Midtrans tidak memuat token atau redirect_url.');
  if (String(orderCode).startsWith('RNT-')) {
    db.prepare(`UPDATE rental_sessions SET payment_reference=?, payment_token=?, payment_url=?, payment_method='midtrans', updated_at=CURRENT_TIMESTAMP WHERE rental_code=?`)
      .run(orderCode, data.token, data.redirect_url, orderCode);
  } else {
    db.prepare(`UPDATE orders SET payment_reference=?, payment_url=?, payment_qr='', payment_method='midtrans', updated_at=CURRENT_TIMESTAMP WHERE order_code=?`)
      .run(orderCode, data.redirect_url, orderCode);
  }
  audit('system', 'midtrans.payment.created', `${orderCode} mode=${settings.payment_mode || 'sandbox'}`);
  return { ...data, payment_url: data.redirect_url, reference: orderCode, provider: 'Midtrans' };
}

async function createDynamicPayment(order) {
  const settings = getSettings();
  if (settings.payment_dynamic_enabled !== '1') throw new Error('QRIS dinamis belum diaktifkan di Panel Admin.');
  if (isMidtrans(settings)) return createMidtransPayment(order, settings);
  if (!settings.payment_create_url || !settings.payment_api_key) throw new Error('URL endpoint atau API Key penyedia pembayaran belum dikonfigurasi.');
  const baseUrl = process.env.PUBLIC_BASE_URL || '';
  const response = await fetch(settings.payment_create_url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.payment_api_key}`, 'X-Merchant-ID': settings.payment_merchant_id || '' },
    body: JSON.stringify({ order_id: order.order_code, amount: order.total ?? order.price, currency: settings.currency || 'IDR', customer_phone: order.wa_id, callback_url: baseUrl ? `${baseUrl.replace(/\/$/, '')}/api/webhooks/payment` : '' }),
    signal: AbortSignal.timeout(20000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `Penyedia pembayaran merespons HTTP ${response.status}`);
  const reference = data.reference || data.transaction_id || data.id;
  if (!reference) throw new Error('Respons provider tidak berisi reference/transaction_id.');
  if (String(order.order_code).startsWith('RNT-')) {
    db.prepare(`UPDATE rental_sessions SET payment_reference=?, payment_url=?, payment_due_at=?, updated_at=CURRENT_TIMESTAMP WHERE rental_code=?`)
      .run(String(reference), data.payment_url || data.checkout_url || '', data.expires_at || order.expires_at, order.order_code);
  } else {
    db.prepare(`UPDATE orders SET payment_reference=?, payment_url=?, payment_qr=?, expires_at=?, updated_at=CURRENT_TIMESTAMP WHERE order_code=?`)
      .run(String(reference), data.payment_url || data.checkout_url || '', data.qr_image_url || data.qr_string || '', data.expires_at || order.expires_at, order.order_code);
  }
  audit('system', 'payment.created', `${order.order_code} ref=${reference}`);
  return { ...data, reference };
}

function verifyMidtransSignature(body, serverKey = midtransServerKey()) {
  if (!serverKey || !body?.signature_key || !body?.order_id || !body?.status_code || body?.gross_amount == null) return false;
  const expected = crypto.createHash('sha512').update(`${body.order_id}${body.status_code}${body.gross_amount}${serverKey}`).digest();
  let actual;
  try { actual = Buffer.from(String(body.signature_key), 'hex'); } catch { return false; }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
async function getMidtransTransactionStatus(orderId, settings = getSettings()) {
  const key = midtransServerKey(settings);
  if (!key) throw new Error('Midtrans Server Key belum dikonfigurasi.');
  return midtransFetch(`${midtransApiBase(settings)}/v2/${encodeURIComponent(orderId)}/status`, key, { method: 'GET' });
}
function verifyWebhook(req) {
  const settings = getSettings();
  const secret = settings.payment_webhook_secret || process.env.PAYMENT_WEBHOOK_SECRET || '';
  const provided = req.get('x-webhook-secret') || req.get('x-payment-secret') || '';
  if (!secret || !provided) return false;
  const expected = Buffer.from(secret), actual = Buffer.from(provided);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function markOrderPaid(orderCode, reference = '') {
  const transaction = db.transaction(() => {
    const order = db.prepare('SELECT * FROM orders WHERE order_code = ?').get(orderCode);
    if (!order) throw new Error('Pesanan tidak ditemukan.');
    if (order.payment_status === 'paid') return order;
    if (order.order_status === 'cancelled' || ['cancelled', 'expired', 'failed'].includes(order.payment_status)) throw new Error('Pesanan tidak lagi dapat ditandai lunas.');
    const items = JSON.parse(order.items_json);
    for (const item of items) {
      const product = db.prepare('SELECT unlimited_stock, stock FROM products WHERE id = ?').get(item.productId);
      if (!product || product.unlimited_stock) continue;
      if ((product.stock ?? 0) < item.quantity) throw new Error(`Stok ${item.name} tidak mencukupi untuk menyelesaikan pesanan.`);
      db.prepare('UPDATE products SET stock = stock - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(item.quantity, item.productId);
    }
    db.prepare(`UPDATE orders SET payment_status='paid', payment_reference=COALESCE(NULLIF(?, ''), payment_reference), updated_at=CURRENT_TIMESTAMP WHERE order_code=?`).run(reference, orderCode);
    audit('system', 'payment.paid', orderCode);
    return db.prepare('SELECT * FROM orders WHERE order_code = ?').get(orderCode);
  });
  return transaction();
}

module.exports = { createOrder, createDynamicPayment, createMidtransPayment, isMidtrans, midtransServerKey, verifyMidtransSignature, getMidtransTransactionStatus, verifyWebhook, markOrderPaid };
