const crypto = require('crypto');
const { getSettings, db, audit } = require('../database/db');

function makeOrderCode() {
  const date = new Date();
  const day = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('');
  return `ORD-${day}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function createOrder({ waId, customerName = '', items, paymentMethod = 'static' }) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Pesanan tidak memiliki item.');
  }

  const normalized = items.map((item) => {
    const product = db
      .prepare('SELECT * FROM products WHERE id = ? AND active = 1')
      .get(Number(item.productId));
    const quantity = Math.max(1, Math.min(1000, Number(item.quantity) || 1));

    if (!product) throw new Error('Produk tidak ditemukan atau tidak aktif.');
    if (!product.unlimited_stock && (product.stock ?? 0) < quantity) {
      throw new Error(`Stok ${product.name} tidak mencukupi.`);
    }

    const unitPrice = product.promo_price != null ? product.promo_price : product.price;
    return {
      productId: product.id,
      sku: product.sku,
      name: product.name,
      quantity,
      unitPrice,
      lineTotal: unitPrice * quantity,
    };
  });

  const subtotal = normalized.reduce((total, item) => total + item.lineTotal, 0);
  const orderCode = makeOrderCode();
  const expiryMinutes = Math.max(5, Number(getSettings().payment_expiry_minutes) || 15);
  const expiresAt = new Date(Date.now() + expiryMinutes * 60_000).toISOString();

  db.prepare(
    `INSERT INTO orders
      (order_code, wa_id, customer_name, items_json, subtotal, total, payment_method, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    orderCode,
    waId,
    customerName,
    JSON.stringify(normalized),
    subtotal,
    subtotal,
    paymentMethod,
    expiresAt,
  );

  audit(waId, 'order.created', `${orderCode} total=${subtotal}`);
  return db.prepare('SELECT * FROM orders WHERE order_code = ?').get(orderCode);
}

async function createDynamicPayment(order) {
  const settings = getSettings();
  if (settings.payment_dynamic_enabled !== '1') {
    throw new Error('QRIS dinamis belum diaktifkan di Admin Panel.');
  }
  if (!settings.payment_create_url || !settings.payment_api_key) {
    throw new Error('URL endpoint atau API Key penyedia pembayaran belum dikonfigurasi.');
  }

  // Generic contract only. Adapt this request/response to the chosen provider's official API.
  const baseUrl = process.env.PUBLIC_BASE_URL || '';
  const response = await fetch(settings.payment_create_url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.payment_api_key}`,
      'X-Merchant-ID': settings.payment_merchant_id || '',
    },
    body: JSON.stringify({
      order_id: order.order_code,
      amount: order.total,
      currency: settings.currency || 'IDR',
      customer_phone: order.wa_id,
      callback_url: baseUrl ? `${baseUrl.replace(/\/$/, '')}/api/webhooks/payment` : '',
    }),
    signal: AbortSignal.timeout(20_000),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || `Penyedia pembayaran merespons HTTP ${response.status}`);
  }

  const reference = data.reference || data.transaction_id || data.id;
  if (!reference) {
    throw new Error('Respons provider tidak berisi reference/transaction_id. Adapter perlu disesuaikan.');
  }

  db.prepare(
    `UPDATE orders SET payment_reference = ?, payment_url = ?, payment_qr = ?,
       expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE order_code = ?`,
  ).run(
    String(reference),
    data.payment_url || data.checkout_url || '',
    data.qr_image_url || data.qr_string || '',
    data.expires_at || order.expires_at,
    order.order_code,
  );

  audit('system', 'payment.created', `${order.order_code} ref=${reference}`);
  return { ...data, reference };
}

function verifyWebhook(req) {
  const settings = getSettings();
  const secret = settings.payment_webhook_secret || process.env.PAYMENT_WEBHOOK_SECRET || '';
  const provided = req.get('x-webhook-secret') || req.get('x-payment-secret') || '';
  if (!secret || !provided) return false;

  const expected = Buffer.from(secret);
  const actual = Buffer.from(provided);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function markOrderPaid(orderCode, reference = '') {
  const transaction = db.transaction(() => {
    const order = db.prepare('SELECT * FROM orders WHERE order_code = ?').get(orderCode);
    if (!order) throw new Error('Pesanan tidak ditemukan.');
    if (order.payment_status === 'paid') return order;
    if (order.order_status === 'cancelled' || ['cancelled', 'expired', 'failed'].includes(order.payment_status)) {
      throw new Error('Pesanan tidak lagi dapat ditandai lunas.');
    }

    const items = JSON.parse(order.items_json);
    for (const item of items) {
      const product = db
        .prepare('SELECT unlimited_stock, stock FROM products WHERE id = ?')
        .get(item.productId);
      if (!product || product.unlimited_stock) continue;
      if ((product.stock ?? 0) < item.quantity) {
        throw new Error(`Stok ${item.name} tidak mencukupi untuk menyelesaikan pesanan.`);
      }
      db.prepare(
        'UPDATE products SET stock = stock - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      ).run(item.quantity, item.productId);
    }

    db.prepare(
      `UPDATE orders SET payment_status = 'paid',
       payment_reference = COALESCE(NULLIF(?, ''), payment_reference),
       updated_at = CURRENT_TIMESTAMP WHERE order_code = ?`,
    ).run(reference, orderCode);

    audit('system', 'payment.paid', orderCode);
    return db.prepare('SELECT * FROM orders WHERE order_code = ?').get(orderCode);
  });

  return transaction();
}

module.exports = { createOrder, createDynamicPayment, verifyWebhook, markOrderPaid };
