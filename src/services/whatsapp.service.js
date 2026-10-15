const fs = require('fs');
const path = require('path');
const pino = require('pino');
const QRCode = require('qrcode');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestWaWebVersion,
} = require('@whiskeysockets/baileys');
const { db, getSettings, audit } = require('../database/db');
const { askOpenRouter } = require('./ai.service');
const { createOrder, createDynamicPayment } = require('./payment.service');

let socket = null;
let qrDataUrl = null;
let connectionStatus = 'DISCONNECTED';
let startPromise = null;
const authDirectory = path.resolve(process.env.AUTH_DIR || './auth');
fs.mkdirSync(authDirectory, { recursive: true });

function recordMessage(waId, direction, sender, body, messageId = '') {
  if (messageId) {
    const existing = db.prepare('SELECT id FROM messages WHERE message_id = ?').get(messageId);
    if (existing) return;
  }

  db.prepare(
    'INSERT INTO messages (wa_id, direction, sender, body, message_id) VALUES (?, ?, ?, ?, ?)',
  ).run(waId, direction, sender, String(body || '').slice(0, 10_000), messageId || '');

  db.prepare(
    `INSERT INTO customers (wa_id, name, last_seen) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(wa_id) DO UPDATE SET
       name = CASE WHEN excluded.name = '' THEN customers.name ELSE excluded.name END,
       last_seen = CURRENT_TIMESTAMP`,
  ).run(waId, sender || '');

  const customer = db.prepare('SELECT id FROM customers WHERE wa_id = ?').get(waId);
  db.prepare(
    `INSERT INTO conversations (wa_id, customer_id, mode, updated_at)
     VALUES (?, ?, 'ai', CURRENT_TIMESTAMP)
     ON CONFLICT(wa_id) DO UPDATE SET
       customer_id = excluded.customer_id,
       updated_at = CURRENT_TIMESTAMP`,
  ).run(waId, customer?.id || null);
}

async function sendText(waId, text) {
  if (!socket || connectionStatus !== 'CONNECTED') {
    throw new Error('WhatsApp belum tersambung.');
  }
  const result = await socket.sendMessage(waId, { text });
  recordMessage(waId, 'out', 'bot', text, result?.key?.id || '');
}

function extractText(message) {
  const content = message.message || {};
  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    content.buttonsResponseMessage?.selectedButtonId ||
    content.listResponseMessage?.singleSelectReply?.selectedRowId ||
    ''
  );
}

function formatPrice(amount) {
  return `Rp${Number(amount || 0).toLocaleString('id-ID')}`;
}

async function sendProductCatalog(waId, settings) {
  const products = db.prepare(
    `SELECT id, name, description, price, promo_price, stock, unlimited_stock
     FROM products WHERE active = 1 ORDER BY name LIMIT 30`,
  ).all();

  if (!products.length) {
    return sendText(waId, 'Saat ini katalog belum tersedia. Ketik *CS* untuk menghubungi admin.');
  }

  const lines = products.map((product, index) => [
    `${index + 1}. *${product.name}*`,
    `   Harga: ${formatPrice(product.promo_price ?? product.price)}`,
    `   Stok: ${product.unlimited_stock ? 'Tersedia' : product.stock}`,
    product.description || '',
  ].filter(Boolean).join('\n'));

  return sendText(
    waId,
    `🛍️ *Katalog ${settings.business_name}*\n\n${lines.join('\n\n')}\n\n` +
      'Untuk memesan, ketik *PESAN nomor_produk jumlah* (contoh: PESAN 1 2).',
  );
}

async function handleOrderCommand(waId, sender, text) {
  const parts = text.trim().split(/\s+/);
  const productIndex = Number(parts[1]);
  const quantity = Math.max(1, Math.min(1000, Number(parts[2]) || 1));
  const products = db.prepare(
    'SELECT id, name FROM products WHERE active = 1 ORDER BY name',
  ).all();
  const product = products[productIndex - 1];

  if (!product) {
    return sendText(waId, 'Nomor produk tidak valid. Ketik *produk* untuk melihat katalog.');
  }

  try {
    const order = createOrder({
      waId,
      customerName: sender,
      items: [{ productId: product.id, quantity }],
      paymentMethod: 'static',
    });
    return sendText(
      waId,
      `🧾 *Pesanan dibuat*\nNomor: ${order.order_code}\nTotal: ${formatPrice(order.total)}\n\n` +
        `Ketik *BAYAR ${order.order_code}* untuk melihat instruksi pembayaran, atau *CS* untuk bantuan.`,
    );
  } catch (error) {
    return sendText(waId, `Pesanan belum bisa dibuat: ${error.message}`);
  }
}

async function handlePaymentCommand(waId, text) {
  const [command, orderCode, ...options] = text.trim().split(/\s+/);
  if (!orderCode) return sendText(waId, 'Format: *BAYAR nomor_pesanan*');

  const order = db.prepare(
    'SELECT * FROM orders WHERE order_code = ? AND wa_id = ?',
  ).get(orderCode.toUpperCase(), waId);
  if (!order) return sendText(waId, 'Pesanan tidak ditemukan untuk nomor WhatsApp ini.');
  if (order.payment_status === 'paid') return sendText(waId, 'Pesanan ini sudah tercatat lunas. Terima kasih!');
  if (order.payment_status !== 'pending') return sendText(waId, `Status pembayaran pesanan ini: ${order.payment_status}. Hubungi CS jika perlu bantuan.`);

  const method = options.join(' ').toLowerCase().includes('dinamis') ? 'dynamic' : 'static';
  if (method === 'dynamic') {
    try {
      const payment = await createDynamicPayment(order);
      const paymentInfo = payment.payment_url || payment.checkout_url || payment.qr_image_url || payment.qr_string || '';
      return sendText(
        waId,
        `💳 *Tagihan QRIS Dinamis*\nPesanan: ${order.order_code}\nTotal: ${formatPrice(order.total)}\n` +
          `${paymentInfo ? `Instruksi/link/QR: ${paymentInfo}\n` : ''}` +
          'Status: menunggu pembayaran. Konfirmasi dilakukan setelah webhook provider diverifikasi.',
      );
    } catch (error) {
      return sendText(
        waId,
        `QRIS dinamis belum tersedia: ${error.message}\n\nKetik *BAYAR ${order.order_code} STATIS* untuk menggunakan QRIS statis.`,
      );
    }
  }

  const settings = getSettings();
  if (!settings.static_qris_image) {
    return sendText(waId, 'QRIS statis belum diatur oleh admin. Silakan ketik *CS*.');
  }

  await sendText(
    waId,
    `💳 *Pembayaran QRIS Statis*\nPesanan: ${order.order_code}\nTotal: ${formatPrice(order.total)}\n` +
      `${settings.static_qris_instructions}\n\nPembayaran akan diverifikasi admin. Screenshot tidak otomatis membuat pesanan lunas.`,
  );

  if (/^https?:\/\//i.test(settings.static_qris_image)) {
    await socket.sendMessage(waId, {
      image: { url: settings.static_qris_image },
      caption: `QRIS statis — ${order.order_code} — ${formatPrice(order.total)}`,
    });
  } else {
    await sendText(waId, 'QRIS harus diatur sebagai URL gambar publik. File upload lokal belum didukung.');
  }
}

async function handleMessage(message) {
  const remoteJid = message.key?.remoteJid;
  if (!remoteJid || remoteJid === 'status@broadcast' || remoteJid.endsWith('@g.us')) return;

  const waId = remoteJid;
  const text = extractText(message).trim();
  if (!text) return;

  if (message.key?.fromMe) {
    recordMessage(waId, 'out', 'phone', text, message.key?.id || '');
    db.prepare(
      `UPDATE conversations SET mode = 'admin', assigned_to = 'admin',
       updated_at = CURRENT_TIMESTAMP WHERE wa_id = ? AND mode = 'waiting_admin'`,
    ).run(waId);
    return;
  }

  const sender = message.pushName || waId.split('@')[0];
  recordMessage(waId, 'in', sender, text, message.key?.id || '');
  const settings = getSettings();
  const conversation = db.prepare('SELECT * FROM conversations WHERE wa_id = ?').get(waId);
  const normalized = text.toLowerCase();

  if (['menu', 'halo', 'hai', 'hi', 'hello', 'start', 'mulai'].includes(normalized)) {
    return sendText(
      waId,
      `${settings.welcome_message.replace('{business}', settings.business_name)}\n\n${settings.menu_text}`,
    );
  }
  if (['produk', '1', 'lihat produk', 'katalog'].includes(normalized)) {
    return sendProductCatalog(waId, settings);
  }
  if (normalized.startsWith('pesan ')) return handleOrderCommand(waId, sender, text);
  if (normalized.startsWith('bayar ')) return handlePaymentCommand(waId, text);

  const asksForHuman = ['cs', 'admin', 'customer service', 'hubungi admin', 'bicara dengan admin', 'pemilik']
    .some((phrase) => normalized === phrase || normalized.includes(phrase));
  if (asksForHuman) {
    db.prepare(
      `UPDATE conversations SET mode = 'waiting_admin', updated_at = CURRENT_TIMESTAMP WHERE wa_id = ?`,
    ).run(waId);
    return sendText(
      waId,
      settings.human_handover_message || 'Permintaan kamu diteruskan ke admin. Mohon tunggu sebentar.',
    );
  }

  if (conversation?.mode === 'admin' || conversation?.mode === 'waiting_admin') return;
  if (settings.auto_reply_enabled === '1') {
    try {
      const reply = await askOpenRouter(waId, text);
      if (reply) return sendText(waId, reply);
    } catch (error) {
      console.error('OpenRouter error:', error.message);
      return sendText(
        waId,
        'Maaf, AI sedang mengalami kendala. Ketik *menu* untuk pilihan otomatis atau *CS* untuk berbicara dengan admin.',
      );
    }
  }

  return sendText(waId, 'Ketik *menu* untuk melihat pilihan layanan atau *CS* untuk menghubungi customer service.');
}

async function startWhatsApp() {
  if (startPromise) return startPromise;

  startPromise = (async () => {
    try {
      connectionStatus = 'CONNECTING';
      const { state, saveCreds } = await useMultiFileAuthState(authDirectory);
      let version;
      try {
        const latestVersion = await fetchLatestWaWebVersion();
        if (latestVersion?.version) version = latestVersion.version;
      } catch (error) {
        console.warn('Could not fetch latest WhatsApp Web version:', error.message);
      }

      const options = {
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ['Chrome', 'Windows'],
        markOnlineOnConnect: false,
        syncFullHistory: false,
      };
      if (version) options.version = version;

      socket = makeWASocket(options);
      socket.ev.on('creds.update', saveCreds);
      socket.ev.on('connection.update', async (update) => {
        if (update.qr) {
          try {
            qrDataUrl = await QRCode.toDataURL(update.qr, { width: 360, margin: 2 });
            connectionStatus = 'QR_REQUIRED';
          } catch (error) {
            console.error('QR generation failed:', error.message);
          }
        }

        if (update.connection === 'open') {
          connectionStatus = 'CONNECTED';
          qrDataUrl = null;
          console.log('WhatsApp connected');
          audit('system', 'whatsapp.connected');
        }

        if (update.connection === 'close') {
          connectionStatus = 'DISCONNECTED';
          const code = update.lastDisconnect?.error?.output?.statusCode;
          console.error('WhatsApp disconnected:', code);
          socket = null;
          startPromise = null;

          if (code !== DisconnectReason.loggedOut) {
            setTimeout(() => startWhatsApp().catch((error) => console.error(error)), 5000);
          } else {
            connectionStatus = 'LOGGED_OUT';
          }
        }
      });

      socket.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const message of messages) {
          try {
            await handleMessage(message);
          } catch (error) {
            console.error('Message processing error:', error.message);
          }
        }
      });
    } catch (error) {
      connectionStatus = 'ERROR';
      startPromise = null;
      console.error('WhatsApp startup failed:', error);
    }
  })();

  return startPromise;
}

function getWhatsAppStatus() {
  return { status: connectionStatus, qr: qrDataUrl, phone: socket?.user?.id || null };
}

async function sendManual(waId, text) {
  if (!socket || connectionStatus !== 'CONNECTED') {
    throw new Error('WhatsApp belum tersambung.');
  }
  db.prepare(
    `UPDATE conversations SET mode = 'admin', assigned_to = 'admin',
     updated_at = CURRENT_TIMESTAMP WHERE wa_id = ?`,
  ).run(waId);
  await sendText(waId, text);
}

function setConversationMode(waId, mode) {
  if (!['ai', 'waiting_admin', 'admin'].includes(mode)) {
    throw new Error('Mode tidak valid.');
  }
  const result = db.prepare(
    `UPDATE conversations SET mode = ?, assigned_to = ?, updated_at = CURRENT_TIMESTAMP WHERE wa_id = ?`,
  ).run(mode, mode === 'admin' ? 'admin' : '', waId);
  if (!result.changes) throw new Error('Percakapan tidak ditemukan.');
}

module.exports = { startWhatsApp, getWhatsAppStatus, sendManual, setConversationMode, sendText };
