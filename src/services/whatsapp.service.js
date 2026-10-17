const fs = require('fs');
const path = require('path');
const pino = require('pino');
const QRCode = require('qrcode');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestWaWebVersion,
  downloadMediaMessage,
} = require('@whiskeysockets/baileys');
const { db, getSettings, audit } = require('../database/db');
const { askOpenRouter } = require('./ai.service');
const { createOrder, createDynamicPayment } = require('./payment.service');
const rentalService = require('./rental.service');

let socket = null;
let qrDataUrl = null;
let connectionStatus = 'DISCONNECTED';
let startPromise = null;
// Keep WhatsApp session files under the shared persistent root by default.
// AUTH_DIR remains supported for existing deployments that explicitly set it.
const storageDirectory = path.resolve(process.env.STORAGE_DIR || './storage');
const authDirectory = path.resolve(process.env.AUTH_DIR || path.join(storageDirectory, 'auth'));
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

function formatRentalTemplate(template, values) {
  return String(template || '').replace(/\{(account|duration|total|code)\}/g, (_, key) => String(values[key] ?? ''));
}

function rentalErrorText(error, settings = getSettings()) {
  const message = String(error?.message || error || 'Terjadi kesalahan.');
  if (/verifikasi|sebelum order, kirim/i.test(message)) {
    return settings.rental_verification_message || '⚠️ _Verifikasi Diperlukan_\nSebelum bisa sewa, wajib kirim ke bot:\n1. Share Lokasi WhatsApp (Lokasi saat ini bukan live location)\n2. Video wajah sambil ucapkan “Rental dulu, Bos”\nSetelah terkirim, ketik ulang perintah _SEWA_.';
  }
  return `Rental belum bisa dibuat: ${message}`;
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
      const paymentInfo = payment.payment_url || payment.redirect_url || payment.checkout_url || payment.qr_image_url || payment.qr_string || '';
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
  const phoneJid = message.key?.remoteJidAlt || message.key?.participantAlt || remoteJid;
  const buyerPhone = (() => { const raw = String(phoneJid || '').split('@')[0].replace(/\D/g, ''); return raw ? `+${raw}` : `+${String(remoteJid.split('@')[0]).replace(/\D/g, '')}`; })();
  const text = extractText(message).trim();
  const incomingContent = message.message || {};
  const hasLocation = Boolean(incomingContent.locationMessage || incomingContent.liveLocationMessage);
  const hasVideo = Boolean(incomingContent.videoMessage);
  if (!text && !hasLocation && !hasVideo) return;

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
  const adminNumber = String(settings.admin_whatsapp || '').replace(/\D/g, '');
  const adminJid = adminNumber ? `${adminNumber}@s.whatsapp.net` : '';
  if (hasLocation) {
    const location = incomingContent.locationMessage || incomingContent.liveLocationMessage;
    rentalService.recordVerification(waId, 'location', location.degreesLatitude, location.degreesLongitude);
    if (adminJid) {
      const phone = buyerPhone;
      await sendText(adminJid, `SHARELOK, ${phone}\nChat pembeli: https://wa.me/${phone.replace(/\D/g, '')}\nLatitude: ${location.degreesLatitude}\nLongitude: ${location.degreesLongitude}\nPeta: https://maps.google.com/?q=${location.degreesLatitude},${location.degreesLongitude}`);
      await socket.sendMessage(adminJid, { location: { degreesLatitude: location.degreesLatitude, degreesLongitude: location.degreesLongitude, name: `Lokasi penyewa ${phone}` } });
    }
    return sendText(waId, '✅ Sharelok diterima dan diteruskan ke admin. Selanjutnya kirim video wajah sambil menyebut “Rental dulu, Bos”. Setelah keduanya diterima, kamu bisa order.');
  }
  if (hasVideo) {
    const phone = buyerPhone;
    const recentCompleted = rentalService.listRentals().find((r) => r.wa_id === waId && r.status === 'completed' && r.ends_at && Date.now() - Date.parse(r.ends_at) < 2 * 60 * 60 * 1000);
    const recentNightCompleted = rentalService.listNightBookings().find((r) => r.wa_id === waId && r.status === 'completed' && r.ends_at && Date.now() - Date.parse(r.ends_at) < 2 * 60 * 60 * 1000);
    const completedEvidence = recentCompleted || recentNightCompleted;
    const evidenceType = completedEvidence ? 'REKAMAN_LOGOUT' : 'VIDEO_MUKA';
    if (!recentCompleted) rentalService.recordVerification(waId, 'video');
    if (adminJid) {
      await sendText(adminJid, `${evidenceType}, ${phone}\nChat pembeli: https://wa.me/${phone.replace(/\D/g, '')}\n${completedEvidence ? `Bukti logout untuk akun ${completedEvidence.account_code} / rental ${completedEvidence.rental_code || completedEvidence.booking_code}.` : 'Video verifikasi diterima. Admin perlu memeriksa secara manual bahwa penyewa menyebut “Rental dulu, Bos”.'}`);
      try {
        const buffer = await downloadMediaMessage(message, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: socket.updateMediaMessage });
        await socket.sendMessage(adminJid, { video: buffer, mimetype: incomingContent.videoMessage.mimetype || 'video/mp4', caption: `${evidenceType}, ${phone}\nChat pembeli: https://wa.me/${phone.replace(/\D/g, '')}` });
      } catch (error) { console.error('Forward rental video failed:', error.message); await sendText(adminJid, `Gagal meneruskan video otomatis untuk ${phone}; minta pelanggan kirim ulang.`); }
    }
    return sendText(waId, recentCompleted ? '✅ Rekaman layar diterima dan diteruskan ke admin untuk pemeriksaan logout.' : '✅ *VIDEO VERIFIKASI DITERIMA*\nAdmin akan memeriksa secara manual apakah kamu mengucapkan “Rental dulu, Bos”. Jika sharelok dan video sudah terkirim, ulangi perintah rental yang tadi kamu kirim.');
  }
  const conversation = db.prepare('SELECT * FROM conversations WHERE wa_id = ?').get(waId);
  const normalized = text.toLowerCase().replace(/[.!?,]+/g, ' ').replace(/\s+/g, ' ').trim();

  if (['menu', 'halo', 'hai', 'hi', 'hello', 'start', 'mulai'].includes(normalized)) {
    return sendText(
      waId,
      `Halo,\nSelamat datang di ${settings.business_name || 'Kwenzy | Utama'}. Ada yang bisa kami bantu bos?\n\n*Silakan pilih dulu boss:*\n1. Rental akun game\n        (Ketik *RENTAL*)\n2. Lihat produk & Layanan (ketik *LIHAT*)\n3. Cara pembayaran (ketik *CARA BAYAR*)\n4. Butuh bantuan (ketik *CS*)\n\n*Contoh: Ketik RENTAL untuk melihat stok, harga, dan cara pemesanan rental game dalam satu pesan*`,
    );
  }
  if (['cara bayar', 'cara pembayaran', '3'].includes(normalized)) return sendText(waId, `💳 *CARA PEMBAYARAN*\nUntuk rental, ikuti instruksi bot dan gunakan kode unik yang diberikan, misalnya *BAYARBOS FF-2 A7*. Untuk pesanan produk, gunakan perintah *BAYAR* sesuai kode pesanan. Jangan mengirim bukti atau membayar ke nomor yang tidak tertera pada instruksi resmi.`);
  if (['produk', 'lihat produk', 'lihat', 'lihat produk & layanan', 'katalog', '2'].includes(normalized)) {
    return sendProductCatalog(waId, settings);
  }
  if (['rental', 'rental bos', 'sewa', 'nyewa', 'mau rental', 'mau sewa', 'rental akun', 'akun game', 'akun rental', 'list', '1'].includes(normalized) || /\b(mau|ingin|pengen)\s+(rental|sewa|nyewa)\b/.test(normalized)) {
    const accounts = rentalService.listAccounts().filter((a) => a.active && a.status === 'available');
    const prices = rentalService.getRentalPrices().filter((p) => p.active);
    const hourly = accounts.filter(a => a.active && a.status === 'available' && String(a.rental_mode || 'hourly') === 'hourly');
    const nightAccounts = accounts.filter(a => a.active && a.status === 'available' && String(a.rental_mode || 'hourly') === 'night');
    const accountLines = hourly.length ? hourly.map((a) => `• *${a.account_code}* — ${a.game_name || a.game_code}`).join('\n') : 'Belum ada akun per jam yang ready.';
    const priceLines = prices.length ? prices.map((p) => `• ${p.game_code} tarif dasar ${p.duration_minutes/60} jam — ${formatPrice(p.price)}${p.custom_duration_enabled ? ' (durasi bebas tersedia)' : ''}`).join('\n') : 'Harga sewa belum diatur admin.';
    const nightStart = settings.rental_night_start || '21:00'; const nightEnd = settings.rental_night_end || '07:00';
    const nightLines = nightAccounts.length ? nightAccounts.map((a) => `• *${a.account_code}* — ${a.game_name || a.game_code}`).join('\n') : 'Belum ada akun paket malam yang ready.';
    const nightPrice = formatPrice(settings.rental_night_price || 30000); const nightDp = formatPrice(settings.rental_booking_dp || 10000);
    const intro = String(settings.rental_intro_message || '').trim();
    const greeting = `Halo!\nSelamat datang di ${settings.business_name || 'Kwenzy | Utama'}. Ada yang bisa kami bantu?`;
    return sendText(waId, `${greeting}\n\n🎮 *RENTAL AKUN GAME*\n\n🔥 *PAKET PER JAM*\n${accountLines}\n\n🌙 *PAKET MALAM (${nightStart}–${nightEnd} WIB)*\n${nightLines}\nHarga paket: *${nightPrice}* · DP: *${nightDp}* · Pelunasan setelah DP terverifikasi.\n\n💰 *TARIF PER JAM*\n${priceLines}\n\n📌 *CARA ORDER — PER JAM*\n1. Cek akun: *CEK KODE-AKUN* (contoh *CEK FF-1*).\n2. Pilih durasi rental: *FF-1 1Jam* untuk 1 jam atau *FF-1 2Jam* untuk 2 jam. Format angka lama *FF-1 1* dan *FF-1 2* tetap bisa digunakan. Sesuaikan kode akun dan jumlah jam yang diinginkan.\n3. Ikuti instruksi verifikasi lokasi dan video jika diminta.\n4. Bot memberi kode pembayaran; bayar dengan *BAYARBOS FF-2 A7* sesuai kode unik milikmu.\n5. Akun dikirim setelah pembayaran terverifikasi.\n\n🌙 *CARA PESAN — PAKET MALAM*\n1. Pilih akun malam dengan format *KODE-AKUN MALAM*, contoh *FF-1 MALAM*.\n2. Booking/DP dan pelunasan mengikuti instruksi bot; akun tidak dikirim saat DP.\n3. Setelah DP terverifikasi, saat jadwal dimulai kirim *FF-1 MALAM* lagi atau ketik *BAYAR PAKET MALAM* untuk melanjutkan ke tagihan pelunasan. Akun dikirim setelah pelunasan terverifikasi.\n\nℹ️ *PERINTAH SINGKAT*\n• *LIST* — stok dan harga\n• *CEK FF-1* — detail akun (ganti FF-1 dengan kode akun yang ingin dicek)\n• *CS* — bantuan admin\n• Pembayaran selalu menggunakan kode unik yang diberikan bot.`);
  }
  if (/^cek\s+[a-z0-9_-]+$/i.test(text.trim())) {
    const accountCode = text.trim().split(/\s+/)[1].toUpperCase();
    const account = rentalService.listAccounts().find((item) => item.account_code.toUpperCase() === accountCode && item.active);
    if (!account) return sendText(waId, 'Akun tidak ditemukan. Ketik *LIST* untuk melihat stok.');
    let photos = []; try { photos = JSON.parse(account.photos_json || '[]'); } catch {}
    const details = `🎮 *${account.account_code}* — ${account.game_name || account.game_code}\nStatus: ${account.status === 'available' ? 'Ready' : 'Sedang disewa/ditahan'}\nSpek: ${account.notes || 'Spesifikasi belum ditambahkan admin.'}`;
    await sendText(waId, details);
    for (const photo of photos.slice(0, 10)) { try { if (/^https?:\/\//i.test(photo)) await socket.sendMessage(waId, { image: { url: photo }, caption: `Foto spek ${account.account_code}` }); } catch (error) { console.error('Rental photo send failed:', error.message); } }
    return;
  }
  if (normalized.includes('akun kena banned') || normalized.includes('kena banned') || normalized.includes('akun tidak bisa diloginkan') || normalized.includes('akun tidak bisa login') || normalized === 'gagal login') {
    try { rentalService.reportIssue(waId); } catch (error) { const adminNumber = String(settings.admin_whatsapp || '').replace(/\D/g, ''); return sendText(waId, `Silakan hubungi owner/CS di sini: ${adminNumber ? `https://wa.me/${adminNumber}` : 'nomor CS belum diatur di panel admin'}. Laporan ini belum terkait dengan sesi rental aktif.`); }
    return;
  }
  // Explicit continuation alias after DP has been verified.
  if (/^bayar\s+paket\s+malam$/i.test(text.trim())) {
    const booking = rentalService.listNightBookings().find((b) => b.wa_id === waId && ['reserved','awaiting_balance'].includes(b.status));
    if (!booking) return sendText(waId, 'Belum ada booking paket malam yang siap dilunasi. Pesan dengan *FF-1 MALAM* terlebih dahulu dan pastikan DP sudah terverifikasi.');
    try {
      const balance = rentalService.continueNightBooking(waId, booking.account_code);
      const payment = await createDynamicPayment(balance); const link = payment.payment_url || payment.redirect_url || payment.checkout_url || '';
      if (!link) return sendText(waId, 'Tagihan pelunasan belum mendapatkan tautan pembayaran. Booking tetap tersimpan; ketik *CS* agar admin memeriksa.');
      return sendText(waId, `🌙 *PELUNASAN PAKET MALAM*\nAkun: *${booking.account_code}*\nDP terverifikasi: *${formatPrice(booking.dp_amount)}*\nSisa pelunasan: *${formatPrice(booking.balance_amount)}*\n\nSilakan bayar melalui Midtrans: ${link}\n🔐 *Data login hanya dikirim setelah pelunasan terverifikasi.*`);
    } catch (error) { return sendText(waId, `Pelunasan belum dapat diproses: ${error.message}`); }
  }
  // Short rental aliases: “FF-2 1Jam” means one hour; old numeric syntax remains supported.
  const shortNight = text.trim().match(/^([A-Z]{2,8}-[A-Z0-9_-]+)\s+MALAM$/i);
  if (shortNight) {
    const account = rentalService.listAccounts().find((a) => a.account_code.toUpperCase() === shortNight[1].toUpperCase() && a.active);
    if (!account) return sendText(waId, 'Akun tidak ditemukan. Ketik *LIST* untuk melihat stok.');
    if (String(account.rental_mode || 'hourly') !== 'night') return sendText(waId, `*${account.account_code}* terdaftar sebagai rental per jam, bukan paket malam. Pilih akun yang ditandai paket malam di LIST.`);
    if (String(settings.rental_booking_enabled || '1') === '0') return sendText(waId, 'Booking paket malam sedang dinonaktifkan admin. Ketik *CS* untuk bantuan.');
    try {
      let booking = rentalService.getNightBooking(waId, account.account_code);
      if (!booking) {
        booking = rentalService.createNightBooking({accountCode:account.account_code,waId,customerName:sender});
        const payment = await createDynamicPayment({order_code:booking.dp_order_code,total:booking.dp_amount,price:booking.dp_amount,wa_id:booking.wa_id,expires_at:booking.due_at});
        const link=payment.payment_url||payment.redirect_url||payment.checkout_url||'';
        if(!link) return sendText(waId,'Booking tercatat tetapi tautan pembayaran tidak tersedia. Jangan membuat booking berulang; ketik CS.');
        return sendText(waId,`🌙 *BOOKING PAKET MALAM*\nAkun: *${booking.account_code}*\nHarga paket: ${formatPrice(booking.total_price)}\nDP sekarang: *${formatPrice(booking.dp_amount)}*\nSisa pelunasan: ${formatPrice(booking.balance_amount)}\nJadwal: ${settings.rental_night_start||'21:00'}–${settings.rental_night_end||'07:00'} WIB\nBatas bayar DP: ${new Date(booking.due_at).toLocaleString('id-ID',{timeZone:'Asia/Jakarta'})} WIB\n\nBayar DP melalui Midtrans: ${link}\nAkun/login tidak akan dikirim pada tahap DP. Setelah DP terverifikasi, ulangi *${account.account_code} MALAM* saat jam mulai untuk membuat tagihan pelunasan.`);
      }
      if (booking.status === 'awaiting_dp') return sendText(waId,`Booking *${account.account_code}* masih menunggu DP ${formatPrice(booking.dp_amount)}. Periksa pesan tagihan sebelumnya. Jika tautan hilang, ketik CS agar admin memeriksa booking sebelum menerbitkan tagihan baru.`);
      const balance = rentalService.continueNightBooking(waId,account.account_code);
      const payment = await createDynamicPayment(balance); const link=payment.payment_url||payment.redirect_url||payment.checkout_url||'';
      if(!link) return sendText(waId,'Pelunasan disiapkan tetapi tautan pembayaran tidak tersedia. Ketik CS; jangan membuat booking baru.');
      return sendText(waId,`🌙 *PELUNASAN PAKET MALAM*\nAkun: *${account.account_code}*\nDP terbayar: ${formatPrice(booking.dp_amount)}\nPelunasan: *${formatPrice(booking.balance_amount)}*\n\nBayar melalui Midtrans: ${link}\nDetail login dikirim otomatis setelah pelunasan terverifikasi.`);
    } catch(error) { return sendText(waId,`Booking paket malam belum dapat diproses: ${error.message}`); }
  }
  const shortHourly = text.trim().match(/^([A-Z]{2,8}-[A-Z0-9_-]+)\s+(\d{1,2})\s*(?:JAM|J)?$/i);
  if (shortHourly) {
    const account = rentalService.listAccounts().find((a) => a.account_code.toUpperCase() === shortHourly[1].toUpperCase() && a.active);
    if (!account) return sendText(waId, 'Akun tidak ditemukan. Ketik *LIST* untuk melihat stok.');
    if (String(account.rental_mode || 'hourly') === 'night') return sendText(waId, `*${account.account_code}* khusus paket malam. Gunakan *${account.account_code} MALAM*; paket malam tidak dihitung per jam.`);
    const hours = Number(shortHourly[2]);
    if (hours < 1 || hours > 24) return sendText(waId, 'Durasi harus 1–24 jam. Contoh: *FF-1 1Jam* atau *FF-1 2Jam*.');
    try {
      const rental = rentalService.createRental({ accountCode: account.account_code, waId, customerName: sender, durationMinutes: hours * 60 });
      if (rental.queued) return sendText(waId, `🕒 *Masuk antrean*\nAkun: *${rental.account_code}*\nDurasi: ${hours} jam. Bot akan memberi tahu saat akun tersedia.`);
      return sendText(waId, formatRentalTemplate(settings.rental_hourly_payment_message, { account: rental.account_code, duration: `${hours} jam`, total: formatPrice(rental.price), code: rental.unique_code }) || `🧾 *PESANAN RENTAL PER JAM*\nAkun: *${rental.account_code}*\nDurasi: *${hours} jam*\nTotal: *${formatPrice(rental.price)}*\nKode bayar: *${rental.unique_code}*\n\n*Langkah berikutnya:* ketik *BAYARBOS ${rental.account_code} ${rental.unique_code}* untuk melanjutkan transaksi dan membuat tagihan pembayaran. Akun hanya dikirim setelah pembayaran terverifikasi.`);
    } catch (error) { return sendText(waId, rentalErrorText(error, settings)); }
  }
  if (normalized.startsWith('sewa ')) {
    const parts = text.trim().split(/\s+/);
    if (parts.length < 2) return sendText(waId, 'Format sewa: *SEWA FF-1 1JAM* atau *SEWA FF-1 60*.');
    const durationToken = String(parts[2] || '60').toUpperCase();
    const durationMatch = durationToken.match(/^(\d+)(MENIT|M|JAM|J|H)?$/);
    const durationMinutes = durationMatch ? Number(durationMatch[1]) * (['JAM','J','H'].includes(durationMatch[2] || '') ? 60 : 1) : Number(durationToken);
    try {
      const rental = rentalService.createRental({ accountCode: parts[1], waId, customerName: sender, durationMinutes });
      if (rental.queued) return sendText(waId, `🕒 *Kamu masuk antrean rental*\nKode antrean: *${rental.rental_code}*\nAkun: *${rental.account_code}*\nPosisi antrean: ${rental.queue_position || 'berikutnya tersedia'}\nKamu belum perlu membayar sekarang. Bot akan memberi tahu saat akun tersedia dan timer pembayaran dimulai.`);
      const staticReady = Boolean(settings.static_qris_image);
      return sendText(waId, `🧾 *Reservasi rental dibuat*\nKode: *${rental.rental_code}*\nKode unik: *${rental.unique_code}*\nAkun: *${rental.account_code}* (${rental.game_name})\nDurasi: ${rental.duration_minutes % 60 === 0 ? `${rental.duration_minutes/60} jam` : `${Math.floor(rental.duration_minutes/60)} jam ${rental.duration_minutes%60} menit`}\nTotal: ${formatPrice(rental.price)}\n\nSelesaikan pembayaran dalam ${Math.max(1, Number(settings.rental_payment_hold_minutes)||20)} menit. Jika lewat, reservasi dibatalkan otomatis dan giliran diberikan kepada antrean berikutnya.\n${settings.payment_dynamic_enabled === '1' ? `Ketik *BAYARBOS ${rental.account_code} ${rental.unique_code}* untuk meminta tagihan otomatis.\nFormat lama tetap bisa: BAYAR RENTAL ${rental.rental_code} DINAMIS` : (staticReady ? `Ketik *BAYARBOS ${rental.account_code} ${rental.unique_code}* atau BAYAR RENTAL ${rental.rental_code} STATIS.` : 'Pembayaran belum diaktifkan admin. Ketik CS untuk bantuan.')}`);
    } catch (error) { return sendText(waId, rentalErrorText(error, settings)); }
  }
  if (normalized.startsWith('bayarbos ')) {
    const parts = text.trim().split(/\s+/);
    const accountCode = String(parts[1] || '').toUpperCase();
    const uniqueCode = String(parts[2] || '').toUpperCase();
    if (!accountCode || !/^[A-Z0-9]{2}$/.test(uniqueCode)) return sendText(waId, 'Format pembayaran: *BAYARBOS FF-1 A7* (kode unik 2 karakter dari bot).');
    const rental = rentalService.listRentals().find((r) => r.wa_id === waId && String(r.account_code).toUpperCase() === accountCode && String(r.unique_code || '').toUpperCase() === uniqueCode);
    if (!rental) return sendText(waId, 'Reservasi tidak ditemukan. Periksa kode akun dan kode unik yang diberikan bot.');
    if (rental.status !== 'waiting_payment') return sendText(waId, `Status reservasi: ${rental.status}. Kode pembayaran hanya berlaku untuk reservasi yang menunggu pembayaran.`);
    if (Date.now() > Date.parse(rental.payment_due_at)) { rentalService.expirePending(); return sendText(waId, 'Batas pembayaran sudah habis. Reservasi dibatalkan otomatis. Silakan pesan kembali.'); }
    try {
      const payment = await createDynamicPayment({ order_code: rental.rental_code, rental_code: rental.rental_code, total: rental.price, price: rental.price, wa_id: rental.wa_id, expires_at: rental.payment_due_at });
      const link = payment.payment_url || payment.redirect_url || payment.checkout_url || '';
      if (!link) return sendText(waId, 'Tagihan dibuat tetapi tautan pembayaran tidak diterima. Hubungi CS; jangan membuat pembayaran berulang.');
      return sendText(waId, `💳 *TAGIHAN RENTAL ${rental.account_code}*\nKode unik: *${uniqueCode}*\nDurasi: ${rental.duration_minutes % 60 === 0 ? `${rental.duration_minutes/60} jam` : `${Math.floor(rental.duration_minutes/60)} jam ${rental.duration_minutes%60} menit`}\nTotal: ${formatPrice(rental.price)}\n\nBayar melalui tautan aman Midtrans berikut:\n${link}\n\nDetail login akan dikirim otomatis setelah pembayaran diverifikasi.`);
    } catch (error) { return sendText(waId, `Pembayaran dinamis belum tersedia: ${error.message}`); }
  }
  if (normalized.startsWith('bayar rental ')) {
    const parts = text.trim().split(/\s+/);
    const rentalCode = String(parts[2] || '').toUpperCase();
    const rental = rentalService.listRentals().find((r) => r.rental_code === rentalCode && r.wa_id === waId);
    if (!rental) return sendText(waId, 'Pesanan rental tidak ditemukan untuk nomor WhatsApp ini.');
    if (rental.status !== 'waiting_payment') return sendText(waId, `Status rental ${rental.rental_code}: ${rental.status}.`);
    if (Date.now() > Date.parse(rental.payment_due_at)) { rentalService.expirePending(); return sendText(waId, 'Batas pembayaran sudah habis. Reservasi dibatalkan otomatis.'); }
    const method = parts.slice(3).join(' ').toLowerCase();
    if (method.includes('dinamis')) {
      try {
        const payment = await createDynamicPayment({ order_code: rental.rental_code, total: rental.price, wa_id: rental.wa_id, expires_at: rental.payment_due_at });
        const link = payment.payment_url || payment.redirect_url || payment.checkout_url || payment.qr_image_url || payment.qr_string || '';
        return sendText(waId, `💳 *Tagihan rental ${rental.rental_code}*\nTotal: ${formatPrice(rental.price)}\n${link ? `Link/QR pembayaran: ${link}\n` : ''}Pembayaran dikonfirmasi otomatis setelah status diverifikasi langsung ke provider.`);
      } catch (error) { return sendText(waId, `Pembayaran dinamis belum tersedia: ${error.message}`); }
    }
    const freshSettings = getSettings();
    if (!freshSettings.static_qris_image) return sendText(waId, 'QRIS statis belum diatur admin. Ketik *CS*.');
    await sendText(waId, `💳 *Pembayaran rental ${rental.rental_code}*\nTotal: ${formatPrice(rental.price)}\n${freshSettings.static_qris_instructions}\nSetelah membayar, tunggu verifikasi admin. Data login baru dikirim setelah pembayaran terverifikasi. Batas reservasi: ${new Date(rental.payment_due_at).toLocaleString('id-ID',{timeZone:'Asia/Jakarta'})}.`);
    if (/^https?:\/\//i.test(freshSettings.static_qris_image)) await socket.sendMessage(waId, { image: { url: freshSettings.static_qris_image }, caption: `QRIS rental ${rental.rental_code} — ${formatPrice(rental.price)}` });
    return;
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
