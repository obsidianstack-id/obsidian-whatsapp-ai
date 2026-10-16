const crypto = require('crypto');
const { db, getSettings, audit } = require('../database/db');

const HOLD_DEFAULT = 20;
function code(prefix) {
  const date = new Date();
  const stamp = `${date.getFullYear()}${String(date.getMonth()+1).padStart(2,'0')}${String(date.getDate()).padStart(2,'0')}`;
  return `${prefix}-${stamp}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}
function mins(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), 7 * 24 * 60) : fallback;
}
function send(waId, text) {
  try { require('./whatsapp.service').sendText(waId, text).catch((e) => console.error('Rental notification failed:', e.message)); }
  catch (e) { console.error('Rental notification failed:', e.message); }
}
function adminNotify(text) {
  const number = String(getSettings().admin_whatsapp || '').replace(/\D/g, '');
  if (!number) return;
  send(`${number}@s.whatsapp.net`, `🔔 *OBSIDIAN RENTAL ADMIN*\n${text}`);
}
function getAccount(id) { return db.prepare('SELECT * FROM rental_accounts WHERE id = ?').get(id); }
function createAccount(input) {
  const gameCode = String(input.game_code || '').trim().toUpperCase();
  const accountCode = String(input.account_code || '').trim().toUpperCase();
  if (!/^[A-Z0-9_-]{2,16}$/.test(gameCode)) throw new Error('Kode game tidak valid (contoh FF atau ML).');
  if (!accountCode.startsWith(`${gameCode}-`) && !accountCode.startsWith(`${gameCode} `)) {
    throw new Error(`Kode akun harus diawali ${gameCode}- (contoh ${gameCode}-1).`);
  }
  const loginType = String(input.login_type || 'Email/ID').trim().slice(0,40);
  const username = String(input.login_username || '').trim();
  const password = String(input.login_password || '').trim();
  if (!username || !password) throw new Error('Username dan password akun wajib diisi.');
  const result = db.prepare(`INSERT INTO rental_accounts (account_code, game_code, game_name, login_type, login_username, login_password, notes, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(accountCode, gameCode, String(input.game_name || gameCode).trim(), loginType, username, password,
      String(input.notes || '').slice(0,1000), input.active === false ? 0 : 1);
  audit('admin', 'rental.account.created', accountCode);
  return getAccount(result.lastInsertRowid);
}
function updateAccount(id, input) {
  const account = getAccount(id);
  if (!account) throw new Error('Akun rental tidak ditemukan.');
  if (['reserved','rented','problem','maintenance'].includes(account.status) && input.account_code && input.account_code !== account.account_code) {
    throw new Error('Kode akun aktif tidak bisa diganti saat sedang digunakan/ditahan.');
  }
  const codeValue = String(input.account_code || account.account_code).trim().toUpperCase();
  const gameCode = String(input.game_code || account.game_code).trim().toUpperCase();
  const loginType = String(input.login_type ?? account.login_type ?? 'Email/ID').trim().slice(0,40);
  const username = String(input.login_username ?? account.login_username).trim();
  const password = String(input.login_password ?? account.login_password).trim();
  if (!codeValue.startsWith(`${gameCode}-`) && !codeValue.startsWith(`${gameCode} `)) throw new Error(`Kode akun harus diawali ${gameCode}-`);
  db.prepare(`UPDATE rental_accounts SET account_code=?, game_code=?, game_name=?, login_type=?, login_username=?, login_password=?, notes=?, active=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(codeValue, gameCode, String(input.game_name ?? account.game_name), loginType, username, password,
      String(input.notes ?? account.notes).slice(0,1000), input.active === false ? 0 : 1, id);
  audit('admin', 'rental.account.updated', codeValue);
  return getAccount(id);
}
function promoteQueue(accountId) {
  const account = getAccount(accountId);
  if (!account || account.status === 'problem' || account.status === 'maintenance') return;
  const next = db.prepare(`SELECT * FROM rental_sessions WHERE account_id=? AND status='queued' ORDER BY id ASC LIMIT 1`).get(accountId);
  if (!next) {
    db.prepare(`UPDATE rental_accounts SET status='available', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(accountId);
    return;
  }
  const holdMinutes = mins(getSettings().rental_payment_hold_minutes, HOLD_DEFAULT);
  const due = new Date(Date.now() + holdMinutes * 60000).toISOString();
  db.prepare(`UPDATE rental_sessions SET status='waiting_payment', payment_due_at=?, queue_position=0, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(due, next.id);
  db.prepare(`UPDATE rental_accounts SET status='reserved', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(accountId);
  send(next.wa_id, `🎮 Akun *${account.account_code}* sekarang tersedia untuk kamu.\nPesanan: *${next.rental_code}*\nDurasi: ${next.duration_minutes} menit\nHarga: Rp${Number(next.price).toLocaleString('id-ID')}\nSelesaikan pembayaran dalam ${holdMinutes} menit. Ketik *BAYAR RENTAL ${next.rental_code}* lalu ikuti instruksi admin/pembayaran.`);
  updateQueuePositions(accountId);
}
function updateQueuePositions(accountId) {
  const queued = db.prepare(`SELECT id FROM rental_sessions WHERE account_id=? AND status='queued' ORDER BY id`).all(accountId);
  const stmt = db.prepare('UPDATE rental_sessions SET queue_position=? WHERE id=?');
  queued.forEach((r, i) => stmt.run(i + 1, r.id));
}
function createRental({ accountCode, waId, customerName='', durationMinutes }) {
  const duration = mins(durationMinutes, 60);
  if (duration < 1) throw new Error('Durasi sewa tidak valid.');
  const account = db.prepare(`SELECT * FROM rental_accounts WHERE account_code=? AND active=1`).get(String(accountCode).toUpperCase());
  if (!account) throw new Error('Kode akun tidak ditemukan atau sedang nonaktif.');
  const priceRow = db.prepare('SELECT price, duration_minutes, custom_duration_enabled FROM rental_prices WHERE game_code=? AND duration_minutes=? AND active=1').get(account.game_code, duration);
  let finalPrice;
  if (priceRow) {
    finalPrice = Number(priceRow.price);
  } else {
    const baseRate = db.prepare('SELECT duration_minutes, price, custom_duration_enabled FROM rental_prices WHERE game_code=? AND active=1 ORDER BY duration_minutes ASC LIMIT 1').get(account.game_code);
    if (!baseRate) throw new Error(`Tarif dasar untuk ${account.game_code} belum diatur admin.`);
    if (!baseRate.custom_duration_enabled) throw new Error(`Durasi ${duration} menit tidak tersedia. Pilih durasi paket yang tercantum.`);
    finalPrice = Math.ceil((duration / Number(baseRate.duration_minutes)) * Number(baseRate.price));
  }
  if (!Number.isSafeInteger(finalPrice) || finalPrice < 1) throw new Error('Harga rental hasil perhitungan tidak valid.');
  const existing = db.prepare(`SELECT id FROM rental_sessions WHERE wa_id=? AND status IN ('waiting_payment','queued','active','problem')`).get(waId);
  if (existing) throw new Error('Kamu sudah memiliki pesanan/sewa yang belum selesai. Selesaikan dulu sebelum membuat pesanan baru.');
  const occupied = account.status !== 'available';
  const holdMinutes = mins(getSettings().rental_payment_hold_minutes, HOLD_DEFAULT);
  const rentalCode = code('RNT');
  const due = new Date(Date.now() + holdMinutes * 60000).toISOString();
  const status = occupied ? 'queued' : 'waiting_payment';
  const transaction = db.transaction(() => {
    const result = db.prepare(`INSERT INTO rental_sessions (rental_code, account_id, wa_id, customer_name, duration_minutes, price, status, payment_due_at, queue_position)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`).run(rentalCode, account.id, waId, customerName, duration, priceRow.price, status, due);
    if (!occupied) db.prepare(`UPDATE rental_accounts SET status='reserved', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(account.id);
    updateQueuePositions(account.id);
    return db.prepare('SELECT * FROM rental_sessions WHERE id=?').get(result.lastInsertRowid);
  });
  const rental = transaction();
  audit(waId, 'rental.created', `${rentalCode} account=${account.account_code} status=${status}`);
  return { ...rental, price: finalPrice, account_code: account.account_code, game_code: account.game_code, game_name: account.game_name, queued: occupied };
}
function getRentalByCode(codeValue) {
  return db.prepare(`SELECT r.*, a.account_code, a.game_code, a.game_name, a.login_username, a.login_password, a.status AS account_status
    FROM rental_sessions r JOIN rental_accounts a ON a.id=r.account_id WHERE r.rental_code=?`).get(codeValue);
}
function markRentalPaid(codeValue, reference='manual-admin') {
  const rental = getRentalByCode(codeValue);
  if (!rental) throw new Error('Pesanan rental tidak ditemukan.');
  if (rental.status === 'active' || rental.payment_status === 'paid') return rental;
  if (rental.status !== 'waiting_payment') throw new Error('Rental tidak sedang menunggu pembayaran. Jika berada dalam antrean, tunggu akun tersedia.');
  if (Date.now() > Date.parse(rental.payment_due_at)) {
    expirePending();
    throw new Error('Batas pembayaran 20 menit sudah habis. Pesanan dibatalkan/antrean dilanjutkan.');
  }
  const transaction = db.transaction(() => {
    db.prepare(`UPDATE rental_sessions SET payment_status='paid', payment_reference=?, status='active', paid_at=?, started_at=?, ends_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(String(reference), new Date().toISOString(), new Date().toISOString(), new Date(Date.now() + rental.duration_minutes*60000).toISOString(), rental.id);
    db.prepare(`UPDATE rental_accounts SET status='rented', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(rental.account_id);
  });
  transaction();
  const active = getRentalByCode(codeValue);
  send(active.wa_id, `✅ Pembayaran rental *${active.rental_code}* terkonfirmasi.\n🎮 Akun: *${active.account_code}* (${active.game_name})\n🔑 Metode login: ${active.login_type || 'Email/ID'}\n👤 Username/ID: ${active.login_username}\n🔐 Password: ${active.login_password}\n⏱️ Durasi: ${active.duration_minutes} menit\n🕒 Waktu sewa mulai sekarang dan berakhir sekitar ${new Date(active.ends_at).toLocaleString('id-ID',{timeZone:'Asia/Jakarta'})}.\n\nJika tidak bisa login, ketik persis: *AKUN TIDAK BISA DILOGINKAN* dalam 3 menit pertama. Jika tidak ada laporan dalam 3 menit, waktu sewa tetap dihitung dari saat pembayaran terkonfirmasi.`);
  adminNotify(`Pembayaran rental ${active.rental_code} terkonfirmasi. Akun ${active.account_code}, penyewa ${active.wa_id}, durasi ${active.duration_minutes} menit.`);
  audit('system', 'rental.paid', `${codeValue} reference=${reference}`);
  return active;
}
function expirePending() {
  const expired = db.prepare(`SELECT * FROM rental_sessions WHERE status='waiting_payment' AND payment_status='pending' AND payment_due_at <= ?`).all(new Date().toISOString());
  for (const rental of expired) {
    const transaction = db.transaction(() => {
      db.prepare(`UPDATE rental_sessions SET status='cancelled', payment_status='expired', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='waiting_payment'`).run(rental.id);
      db.prepare(`UPDATE rental_accounts SET status='available', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='reserved'`).run(rental.account_id);
    });
    transaction();
    send(rental.wa_id, `⌛ Pesanan rental *${rental.rental_code}* dibatalkan otomatis karena pembayaran tidak diterima dalam batas waktu. Jika masih ingin menyewa, kirim perintah SEWA lagi.`);
    audit('system', 'rental.payment_expired', rental.rental_code);
    promoteQueue(rental.account_id);
  }
}
function reportIssue(waId) {
  const rental = db.prepare(`SELECT r.*, a.account_code FROM rental_sessions r JOIN rental_accounts a ON a.id=r.account_id WHERE r.wa_id=? AND r.status='active' ORDER BY r.id DESC LIMIT 1`).get(waId);
  if (!rental) throw new Error('Tidak ada sesi rental aktif untuk nomor kamu.');
  const now = new Date().toISOString();
  db.prepare(`UPDATE rental_sessions SET status='problem', paused_at=?, issue_reported_at=?, issue_note='Pelanggan melaporkan tidak bisa login', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(now, now, rental.id);
  db.prepare(`UPDATE rental_accounts SET status='problem', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(rental.account_id);
  send(waId, `⚠️ Laporan akun bermasalah untuk *${rental.account_code}* diterima. Waktu sewa dijeda sejak laporan ini. Admin akan memeriksa akun. Waktu perbaikan tidak dihitung selama status perbaikan.`);
  adminNotify(`🚨 AKUN BERMASALAH\nAkun: ${rental.account_code}\nPenyewa: ${rental.customer_name || waId} (${waId})\nRental: ${rental.rental_code}\nWaktu laporan: ${now}\nBuka panel Rental → Bermasalah untuk memeriksa dan menandai akun normal.`);
  audit(waId, 'rental.issue_reported', rental.rental_code);
  return getRentalByCode(rental.rental_code);
}
function resolveIssue(id, note='Akun sudah diperiksa admin dan dinyatakan normal.') {
  const rental = db.prepare(`SELECT r.*, a.account_code FROM rental_sessions r JOIN rental_accounts a ON a.id=r.account_id WHERE r.id=? AND r.status='problem'`).get(id);
  if (!rental) throw new Error('Sesi bermasalah tidak ditemukan.');
  const now = Date.now();
  const pausedAt = Date.parse(rental.paused_at || rental.issue_reported_at || new Date().toISOString());
  const pausedDuration = Math.max(0, now - pausedAt);
  const originalEnd = Date.parse(rental.ends_at);
  const newEnd = new Date(originalEnd + pausedDuration).toISOString();
  db.prepare(`UPDATE rental_sessions SET status='active', paused_seconds=paused_seconds+?, paused_at='', issue_note=?, ends_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(Math.floor(pausedDuration/1000), String(note).slice(0,1000), newEnd, id);
  db.prepare(`UPDATE rental_accounts SET status='rented', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(rental.account_id);
  send(rental.wa_id, `✅ Akun *${rental.account_code}* sudah diperbaiki dan dinyatakan normal oleh admin. Silakan coba login kembali. Waktu sewa dilanjutkan; masa perbaikan tidak dihitung. Perkiraan akhir sewa: ${new Date(newEnd).toLocaleString('id-ID',{timeZone:'Asia/Jakarta'})}.`);
  audit('admin', 'rental.issue_resolved', `${rental.rental_code}: ${note}`);
  return getRentalByCode(rental.rental_code);
}
function expireActive() {
  const nowIso = new Date().toISOString();
  const expired = db.prepare(`SELECT r.*, a.account_code FROM rental_sessions r JOIN rental_accounts a ON a.id=r.account_id WHERE r.status='active' AND r.ends_at <= ?`).all(nowIso);
  for (const rental of expired) {
    db.prepare(`UPDATE rental_sessions SET status='completed', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(rental.id);
    db.prepare(`UPDATE rental_accounts SET status='available', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(rental.account_id);
    send(rental.wa_id, `⏰ Waktu sewa *${rental.account_code}* telah habis. Akun sekarang tersedia untuk penyewa berikutnya. Terima kasih sudah menyewa.`);
    audit('system', 'rental.expired', rental.rental_code);
    promoteQueue(rental.account_id);
  }
}
function sendThreeMinuteReminders() {
  const cutoff = new Date(Date.now() - mins(getSettings().rental_issue_report_minutes, 3)*60000).toISOString();
  const due = db.prepare(`SELECT r.*, a.account_code FROM rental_sessions r JOIN rental_accounts a ON a.id=r.account_id WHERE r.status='active' AND r.issue_reminder_sent=0 AND r.started_at <= ?`).all(cutoff);
  for (const rental of due) {
    db.prepare('UPDATE rental_sessions SET issue_reminder_sent=1 WHERE id=?').run(rental.id);
    send(rental.wa_id, `⏱️ Pengingat: jika *${rental.account_code}* tidak bisa diloginkan, ketik *AKUN TIDAK BISA DILOGINKAN*. Karena belum ada laporan masalah dalam ${mins(getSettings().rental_issue_report_minutes,3)} menit pertama, waktu sewa tetap berjalan sejak pembayaran dikonfirmasi.`);
  }
}
function listRentals() {
  return db.prepare(`SELECT r.*, a.account_code, a.game_code, a.game_name, a.status AS account_status
    FROM rental_sessions r JOIN rental_accounts a ON a.id=r.account_id ORDER BY r.id DESC LIMIT 300`).all();
}
function listAccounts() {
  return db.prepare(`SELECT a.*, (SELECT COUNT(*) FROM rental_sessions r WHERE r.account_id=a.id AND r.status IN ('waiting_payment','queued','active','problem')) AS active_rentals FROM rental_accounts a ORDER BY a.game_code, a.account_code`).all();
}
function deleteAccount(id) {
  const account = getAccount(id);
  if (!account) throw new Error('Akun tidak ditemukan.');
  if (['reserved','rented','problem'].includes(account.status)) throw new Error('Akun sedang digunakan/ditahan dan tidak bisa dihapus.');
  db.prepare('DELETE FROM rental_accounts WHERE id=?').run(id);
  audit('admin', 'rental.account.deleted', account.account_code);
}
function getRentalPrices() { return db.prepare('SELECT * FROM rental_prices ORDER BY game_code, duration_minutes').all(); }
function upsertPrice(input) {
  const gameCode = String(input.game_code || '').trim().toUpperCase();
  const duration = mins(input.duration_minutes, 0);
  const price = Math.round(Number(input.price));
  if (!gameCode || !duration || !Number.isFinite(price) || price < 1) throw new Error('Kode game, durasi, dan harga valid wajib diisi.');
  db.prepare(`INSERT INTO rental_prices (game_code, duration_minutes, price, active, custom_duration_enabled) VALUES (?,?,?,1,?)
    ON CONFLICT(game_code,duration_minutes) DO UPDATE SET price=excluded.price, active=1, custom_duration_enabled=excluded.custom_duration_enabled`).run(gameCode,duration,price,input.custom_duration_enabled === false || String(input.custom_duration_enabled)==='0' ? 0 : 1);
  audit('admin','rental.price.updated',`${gameCode}:${duration}=${price}`);
}
function setMaintenance(id, enabled) {
  const account = getAccount(id);
  if (!account) throw new Error('Akun tidak ditemukan.');
  if (['reserved','rented','problem'].includes(account.status) && enabled) throw new Error('Akun sedang dipakai/ditahan; selesaikan sesi aktif dahulu.');
  db.prepare(`UPDATE rental_accounts SET status=?, active=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(enabled?'maintenance':'available', enabled?0:1,id);
  if (!enabled) promoteQueue(id);
}
function getRentalById(id) { return db.prepare(`SELECT r.*, a.account_code, a.game_code, a.game_name, a.status AS account_status FROM rental_sessions r JOIN rental_accounts a ON a.id=r.account_id WHERE r.id=?`).get(id); }

// Idempotent periodic maintenance. Timers run in-process; keep a single Railway replica for this SQLite-backed app.
setInterval(() => { try { expirePending(); expireActive(); sendThreeMinuteReminders(); } catch (error) { console.error('Rental maintenance error:', error.message); } }, 15_000).unref();

module.exports = { createAccount, updateAccount, deleteAccount, listAccounts, createRental, markRentalPaid, expirePending, reportIssue, resolveIssue, expireActive, listRentals, getRentalPrices, upsertPrice, setMaintenance };
