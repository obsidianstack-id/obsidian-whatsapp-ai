const crypto = require('crypto');
const { db, getSettings, audit } = require('../database/db');

const HOLD_DEFAULT = 20;
function code(prefix) {
  const date = new Date();
  const stamp = `${date.getFullYear()}${String(date.getMonth()+1).padStart(2,'0')}${String(date.getDate()).padStart(2,'0')}`;
  return `${prefix}-${stamp}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}
function normalizeWaId(value) { const raw = String(value || '').trim(); if (raw.includes('@')) return raw; const digits = raw.replace(/\D/g, ''); return digits ? `${digits}@s.whatsapp.net` : ''; }
function displayPhone(value) { const digits = String(value || '').split('@')[0].replace(/\D/g, ''); return digits ? `+${digits}` : 'nomor tidak tersedia'; }
function shortUniqueCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 30; attempt++) {
    const bytes = crypto.randomBytes(2);
    const value = alphabet[bytes[0] % alphabet.length] + alphabet[bytes[1] % alphabet.length];
    const exists = db.prepare("SELECT 1 FROM rental_sessions WHERE unique_code=? AND status IN ('waiting_payment','queued','active','problem') LIMIT 1").get(value);
    if (!exists) return value;
  }
  throw new Error('Kode unik sedang penuh. Coba lagi sebentar.');
}
function mins(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), 7 * 24 * 60) : fallback;
}
function formatDuration(minutes) { const value=Number(minutes)||0; return value%60===0 ? `${value/60} jam` : `${Math.floor(value/60)} jam ${value%60} menit`; }
function send(waId, text) {
  try { require('./whatsapp.service').sendText(waId, text).catch((e) => console.error('Rental notification failed:', e.message)); }
  catch (e) { console.error('Rental notification failed:', e.message); }
}
function adminNotify(text) {
  const number = String(getSettings().admin_whatsapp || '').replace(/\D/g, '');
  if (!number) return;
  send(`${number}@s.whatsapp.net`, `🔔 *KWENZY | UTAMA — RENTAL ADMIN*\n${text}`);
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
  const photos = Array.isArray(input.photos) ? input.photos : String(input.photos_text || '').split(/\r?\n/).map(v => v.trim()).filter(Boolean);
  const requestedMode = String(input.rental_mode || 'hourly').toLowerCase();
  const rentalMode = ['hourly','night','auto'].includes(requestedMode) ? requestedMode : 'hourly';
  if (photos.length > 10 || photos.some(v => !/^https?:\/\//i.test(String(v)))) throw new Error('Foto harus maksimal 10 URL gambar (unggah melalui panel atau masukkan URL publik).');
  if (!username || !password) throw new Error('Username dan password akun wajib diisi.');
  const result = db.prepare(`INSERT INTO rental_accounts (account_code, game_code, game_name, login_type, login_username, login_password, notes, photos_json, rental_mode, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(accountCode, gameCode, String(input.game_name || gameCode).trim(), loginType, username, password,
      String(input.notes || '').slice(0,1000), JSON.stringify(photos), rentalMode, input.active === false ? 0 : 1);
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
  let photos = input.photos != null ? input.photos : (input.photos_text != null ? String(input.photos_text).split(/\r?\n/).map(v => v.trim()).filter(Boolean) : JSON.parse(account.photos_json || '[]'));
  if (!Array.isArray(photos)) photos = [];
  const requestedMode = String(input.rental_mode ?? account.rental_mode ?? 'hourly').toLowerCase();
  const rentalMode = ['hourly','night','auto'].includes(requestedMode) ? requestedMode : 'hourly';
  if (photos.length > 10 || photos.some(v => !/^https?:\/\//i.test(String(v)))) throw new Error('Foto harus maksimal 10 URL gambar (unggah melalui panel atau masukkan URL publik).');
  if (!codeValue.startsWith(`${gameCode}-`) && !codeValue.startsWith(`${gameCode} `)) throw new Error(`Kode akun harus diawali ${gameCode}-`);
  db.prepare(`UPDATE rental_accounts SET account_code=?, game_code=?, game_name=?, login_type=?, login_username=?, login_password=?, notes=?, photos_json=?, rental_mode=?, active=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(codeValue, gameCode, String(input.game_name ?? account.game_name), loginType, username, password,
      String(input.notes ?? account.notes).slice(0,1000), JSON.stringify(photos), rentalMode, input.active === false ? 0 : 1, id);
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
  send(next.wa_id, `🎮 Akun *${account.account_code}* sekarang tersedia untuk kamu.\nDurasi: ${formatDuration(next.duration_minutes)}\nHarga: Rp${Number(next.price).toLocaleString('id-ID')}\nKode unik: *${next.unique_code || 'cek reservasi'}*\nSelesaikan pembayaran dalam ${holdMinutes} menit. Ketik *BAYARBOS ${account.account_code} ${next.unique_code}* untuk meminta tagihan. Format lama: BAYAR RENTAL ${next.rental_code} DINAMIS.`);
  updateQueuePositions(accountId);
}
function updateQueuePositions(accountId) {
  const queued = db.prepare(`SELECT id FROM rental_sessions WHERE account_id=? AND status='queued' ORDER BY id`).all(accountId);
  const stmt = db.prepare('UPDATE rental_sessions SET queue_position=? WHERE id=?');
  queued.forEach((r, i) => stmt.run(i + 1, r.id));
}

function isNightHours(now = new Date()) {
  const settings = getSettings();
  const parse = (value, fallback) => { const m = String(value || fallback).match(/^(\d{1,2}):(\d{2})$/); return m ? Number(m[1])*60+Number(m[2]) : fallback === '21:00' ? 1260 : 420; };
  const start = parse(settings.rental_night_start, '21:00');
  const end = parse(settings.rental_night_end, '07:00');
  const jakarta = new Date(now.getTime() + 7*3600000);
  const current = jakarta.getUTCHours()*60 + jakarta.getUTCMinutes();
  return start === end ? true : (start < end ? current >= start && current < end : current >= start || current < end);
}
function effectiveRentalMode(account, now = new Date()) {
  const configured = String(account.rental_mode || 'hourly').toLowerCase();
  if (configured === 'night') return 'night';
  if (configured === 'auto') return isNightHours(now) ? 'night' : 'hourly';
  return 'hourly';
}

function createNightBooking({ accountCode, waId, customerName='' }) {
  const normalized = normalizeWaId(waId);
  const blocked = db.prepare('SELECT reason FROM rental_blacklist WHERE wa_id=?').get(normalized);
  if (blocked) throw new Error('Nomor WhatsApp ini tidak dapat menyewa. Hubungi CS jika merasa ini kesalahan.');
  const verification = db.prepare('SELECT location_received, video_received FROM rental_verifications WHERE wa_id=?').get(normalized);
  if (!verification || !verification.location_received || !verification.video_received) throw new Error('⚠️ VERIFIKASI DIPERLUKAN\nSebelum booking, kirim ke bot: (1) Share Lokasi WhatsApp lokasi saat ini, bukan live location; (2) video wajah sambil mengucapkan “Rental dulu, Bos”. Setelah keduanya terkirim, ulangi perintah order.');
  const account = db.prepare('SELECT * FROM rental_accounts WHERE account_code=? AND active=1').get(String(accountCode).toUpperCase());
  if (!account) throw new Error('Akun paket malam tidak ditemukan atau tidak aktif. Ketik LIST untuk melihat stok.');
  if (effectiveRentalMode(account) !== 'night') throw new Error(`Akun ${account.account_code} saat ini dikonfigurasi untuk rental per jam. Pilih akun paket malam atau akun mode OTOMATIS saat jam malam.`);
  const existing = db.prepare("SELECT booking_code FROM rental_night_bookings WHERE wa_id=? AND status IN ('awaiting_dp','reserved','awaiting_balance','active')").get(normalized);
  const accountHold = db.prepare("SELECT booking_code FROM rental_night_bookings WHERE account_id=? AND status IN ('awaiting_dp','reserved','awaiting_balance','active')").get(account.id);
  if (accountHold) throw new Error('Akun ini sudah memiliki booking yang sedang diproses. Pilih akun lain atau tunggu statusnya selesai.');
  if (existing) throw new Error(`Kamu sudah memiliki booking paket malam ${existing.booking_code} yang belum selesai.`);
  if (account.status !== 'available') {
    const alternatives = db.prepare("SELECT account_code, game_name, notes FROM rental_accounts WHERE game_code=? AND active=1 AND status='available' AND id<>? ORDER BY id LIMIT 3").all(account.game_code, account.id);
    throw new Error(`Akun ${account.account_code} sedang tidak tersedia.${alternatives.length ? ` Alternatif tersedia: ${alternatives.map(a=>a.account_code+(a.notes?` (${a.notes})`:'' )).join(', ')}. Pesan salah satu dengan format KODE MALAM.` : ' Belum ada akun alternatif dengan game yang sama.'}`);
  }
  const price = Math.round(Number(db.prepare("SELECT value FROM settings WHERE key='rental_night_price'").get()?.value || 30000));
  const dp = Math.round(Number(getSettings().rental_booking_dp || 10000));
  if (!Number.isSafeInteger(price) || price < 1 || !Number.isSafeInteger(dp) || dp < 1 || dp >= price) throw new Error('Harga paket malam/DP belum valid. Admin harus mengatur DP lebih kecil dari harga paket.');
  const bookingCode = code('NGT'); const dpOrderCode = `${bookingCode}-DP`;
  const hold = mins(getSettings().rental_payment_hold_minutes, HOLD_DEFAULT);
  const due = new Date(Date.now()+hold*60000).toISOString();
  const result = db.transaction(() => {
    const inserted = db.prepare(`INSERT INTO rental_night_bookings (booking_code,dp_order_code,account_id,wa_id,customer_name,total_price,dp_amount,balance_amount,due_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(bookingCode,dpOrderCode,account.id,normalized,customerName,price,dp,price-dp,due);
    db.prepare("UPDATE rental_accounts SET status='reserved', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='available'").run(account.id);
    return inserted;
  })();
  audit(normalized,'rental.night.booking.created',`${bookingCode} account=${account.account_code} dp=${dp}`);
  return { ...db.prepare('SELECT * FROM rental_night_bookings WHERE id=?').get(result.lastInsertRowid), account_code:account.account_code, game_name:account.game_name, game_code:account.game_code };
}
function getNightBookingByOrder(orderCode) { return db.prepare(`SELECT n.*, a.account_code,a.game_name,a.game_code,a.login_type,a.login_username,a.login_password FROM rental_night_bookings n JOIN rental_accounts a ON a.id=n.account_id WHERE n.dp_order_code=? OR n.balance_order_code=?`).get(orderCode,orderCode); }
function getNightBooking(waId, accountCode) { return db.prepare(`SELECT n.*,a.account_code,a.game_name FROM rental_night_bookings n JOIN rental_accounts a ON a.id=n.account_id WHERE n.wa_id=? AND a.account_code=? AND n.status IN ('awaiting_dp','reserved','awaiting_balance','active') ORDER BY n.id DESC LIMIT 1`).get(normalizeWaId(waId),String(accountCode).toUpperCase()); }
function nightStartDate(now = new Date()) {
  const settings=getSettings(); const [h,m]=String(settings.rental_night_start||'21:00').split(':').map(Number);
  const localNow=new Date(now.getTime()+7*3600000); const start=new Date(Date.UTC(localNow.getUTCFullYear(),localNow.getUTCMonth(),localNow.getUTCDate(),h||21,m||0)-7*3600000);
  if(now.getTime()>=start.getTime()+1) start.setUTCDate(start.getUTCDate()+1);
  return start;
}
function nightWindow(now = new Date()) {
  const settings=getSettings(); const [sh,sm]=String(settings.rental_night_start||'21:00').split(':').map(Number); const [eh,em]=String(settings.rental_night_end||'06:00').split(':').map(Number);
  const localNow=new Date(now.getTime()+7*3600000); const start=new Date(Date.UTC(localNow.getUTCFullYear(),localNow.getUTCMonth(),localNow.getUTCDate(),sh||21,sm||0)-7*3600000);
  const end=new Date(Date.UTC(localNow.getUTCFullYear(),localNow.getUTCMonth(),localNow.getUTCDate(),eh||6,em||0)-7*3600000); if(end<=start) end.setUTCDate(end.getUTCDate()+1);
  if(now<start) return {start,end}; if(now>=end) { start.setUTCDate(start.getUTCDate()+1); end.setUTCDate(end.getUTCDate()+1); } return {start,end};
}
function continueNightBooking(waId, accountCode) {
  const booking=getNightBooking(waId,accountCode); if(!booking) throw new Error('Booking paket malam tidak ditemukan. Mulai dengan KODE-AKUN MALAM.');
  if(booking.status==='awaiting_dp') throw new Error('DP belum terverifikasi. Selesaikan pembayaran DP terlebih dahulu.');
  if(booking.status==='active') throw new Error('Paket malam ini sudah aktif.');
  const window=nightWindow(); const now=new Date();
  if(now<window.start || now>=window.end) throw new Error(`Paket malam belum dapat dilanjutkan. Jam mulai: ${getSettings().rental_night_start||'21:00'} WIB; jam selesai: ${getSettings().rental_night_end||'06:00'} WIB. Ulangi perintah ${accountCode} MALAM saat jadwal dimulai.`);
  if(booking.status!=='reserved' && booking.status!=='awaiting_balance') throw new Error('Status booking tidak mengizinkan pelunasan. Hubungi CS.');
  const orderCode=booking.balance_order_code || `${booking.booking_code}-BAL`;
  db.prepare("UPDATE rental_night_bookings SET status='awaiting_balance', balance_order_code=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(orderCode,booking.id);
  return { ...booking, balance_order_code:orderCode, total:booking.balance_amount, order_code:orderCode, price:booking.balance_amount, wa_id:booking.wa_id, expires_at:booking.due_at };
}
function markNightPaid(orderCode, reference='midtrans') {
  const booking=getNightBookingByOrder(orderCode); if(!booking) throw new Error('Booking paket malam tidak ditemukan.');
  if(orderCode===booking.dp_order_code) {
    if(['reserved','awaiting_balance','active','completed'].includes(booking.status)) return {duplicate:true,booking};
    if(booking.status!=='awaiting_dp') return {duplicate:true,booking};
    const freshAccount=getAccount(booking.account_id); if (!freshAccount || !['available','reserved'].includes(freshAccount.status)) throw new Error('DP terdeteksi tetapi akun sedang digunakan/maintenance. Admin harus memeriksa transaksi ini sebelum akun dikirim.');
    const window=nightWindow();
    db.transaction(()=>{ db.prepare("UPDATE rental_night_bookings SET status='reserved',payment_status='dp_paid',dp_reference=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='awaiting_dp'").run(String(reference),booking.id); db.prepare("UPDATE rental_accounts SET status='reserved',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('available','reserved')").run(booking.account_id); })();
    send(booking.wa_id,`✅ DP paket malam *${booking.account_code}* terverifikasi. Nominal DP: Rp${booking.dp_amount.toLocaleString('id-ID')}. Akun belum dikirim pada tahap DP. Jam mulai paket: ${getSettings().rental_night_start||'21:00'} WIB. Saat jam mulai, kirim ulang *${booking.account_code} MALAM* untuk membuat tagihan pelunasan Rp${booking.balance_amount.toLocaleString('id-ID')}.`);
    adminNotify(`DP PAKET MALAM TERVERIFIKASI\nNomor: ${displayPhone(booking.wa_id)}\nAkun: ${booking.account_code}\nBooking: ${booking.booking_code}\nDP: Rp${booking.dp_amount.toLocaleString('id-ID')}\nMulai: ${window.start.toLocaleString('id-ID',{timeZone:'Asia/Jakarta'})}`);
    return {booking,stage:'dp'};
  }
  if(orderCode===booking.balance_order_code) {
    if(booking.status==='active' || booking.status==='completed') return {duplicate:true,booking};
    if(booking.status!=='awaiting_balance') throw new Error('Pembayaran pelunasan tidak sedang ditunggu.');
    const window=nightWindow(); const now=new Date(); const start=now<window.start?window.start:now; const end=window.end;
    if(end<=start) throw new Error('Waktu paket malam telah berakhir; hubungi admin untuk penanganan booking.');
    db.transaction(()=>{db.prepare("UPDATE rental_night_bookings SET status='active',payment_status='paid',balance_reference=?,started_at=?,ends_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='awaiting_balance'").run(String(reference),start.toISOString(),end.toISOString(),booking.id);db.prepare("UPDATE rental_accounts SET status='rented',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(booking.account_id);})();
    const active=getNightBookingByOrder(orderCode);
    send(active.wa_id,`✅ *PELUNASAN PAKET MALAM TERVERIFIKASI*\nAkun: *${active.account_code}* (${active.game_name})\nLogin: ${active.login_type||'Email/ID'}\nUsername/ID: ${active.login_username}\nPassword: ${active.login_password}\nMulai: ${new Date(active.started_at).toLocaleString('id-ID',{timeZone:'Asia/Jakarta'})} WIB\nBerakhir: ${new Date(active.ends_at).toLocaleString('id-ID',{timeZone:'Asia/Jakarta'})} WIB\nSilakan logout tepat waktu dan kirim rekaman layar logout.`);
    adminNotify(`PAKET MALAM DIMULAI\nNomor: ${displayPhone(active.wa_id)}\nAkun: ${active.account_code}\nBooking: ${active.booking_code}\nMulai: ${new Date(active.started_at).toLocaleString('id-ID',{timeZone:'Asia/Jakarta'})}\nBerakhir: ${new Date(active.ends_at).toLocaleString('id-ID',{timeZone:'Asia/Jakarta'})}`);
    return {booking:active,stage:'balance'};
  }
  throw new Error('Kode transaksi tidak cocok dengan booking paket malam.');
}
function notifyNightStart() {
  const now=new Date(); const window=nightWindow(now); const rows=db.prepare("SELECT n.*,a.account_code FROM rental_night_bookings n JOIN rental_accounts a ON a.id=n.account_id WHERE n.status='reserved' AND n.notified_start=0").all();
  for(const b of rows){ if(now>=window.start && now<window.end){ db.prepare('UPDATE rental_night_bookings SET notified_start=1 WHERE id=? AND notified_start=0').run(b.id); send(b.wa_id,`🌙 Paket malam sudah dimulai. Untuk melanjutkan booking *${b.account_code}*, kirim ulang *${b.account_code} MALAM* untuk membuat tagihan pelunasan. Akun dikirim setelah pelunasan terverifikasi.`); } }
}

function expireNightActive(){
 const rows=db.prepare("SELECT n.*,a.account_code FROM rental_night_bookings n JOIN rental_accounts a ON a.id=n.account_id WHERE n.status='active' AND n.ends_at<>'' AND n.ends_at<=?").all(new Date().toISOString());
 for(const b of rows){ db.prepare("UPDATE rental_night_bookings SET status='completed',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='active'").run(b.id); db.prepare("UPDATE rental_accounts SET status='maintenance',active=0,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(b.account_id); send(b.wa_id,`⏰ Paket malam *${b.account_code}* telah berakhir. Silakan logout dan kirim rekaman layar logout. Akun masuk status maintenance sampai admin memeriksa bukti logout dan mengaktifkannya kembali.`); adminNotify(`PAKET MALAM SELESAI\nNomor: ${displayPhone(b.wa_id)}\nAkun: ${b.account_code}\nBooking: ${b.booking_code}\nSelesai: ${new Date(b.ends_at).toLocaleString('id-ID',{timeZone:'Asia/Jakarta'})}\nMenunggu rekaman logout dan pemeriksaan admin.`); audit('system','rental.night.completed',b.booking_code); }
 const due=db.prepare("SELECT n.*,a.account_code FROM rental_night_bookings n JOIN rental_accounts a ON a.id=n.account_id WHERE n.status='active' AND n.reminder_5_sent=0 AND n.ends_at>? AND n.ends_at<=?").all(new Date().toISOString(),new Date(Date.now()+5*60000).toISOString());
 for(const b of due){db.prepare('UPDATE rental_night_bookings SET reminder_5_sent=1 WHERE id=? AND reminder_5_sent=0').run(b.id);send(b.wa_id,`⏰ Bos, paket malam *${b.account_code}* tersisa 5 menit. Siapkan logout dan kirim rekaman layar setelah keluar dari akun.`);}
}

function expireNightBookings(){ const rows=db.prepare("SELECT * FROM rental_night_bookings WHERE status='awaiting_dp' AND due_at<>'' AND due_at<=?").all(new Date().toISOString()); for(const b of rows){ db.transaction(()=>{db.prepare("UPDATE rental_night_bookings SET status='cancelled',payment_status='dp_expired',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='awaiting_dp'").run(b.id); db.prepare("UPDATE rental_accounts SET status='available',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='reserved' AND NOT EXISTS (SELECT 1 FROM rental_night_bookings n WHERE n.account_id=? AND n.status IN ('awaiting_dp','reserved','awaiting_balance','active'))").run(b.account_id,b.account_id);})(); send(b.wa_id,'⌛ Batas pembayaran DP paket malam habis. Booking dibatalkan; akun dilepas kembali jika tidak ada booking lain. Silakan pesan ulang jika stok masih tersedia.'); } }

function createRental({ accountCode, waId, customerName='', durationMinutes }) {
  const blocked = db.prepare('SELECT reason FROM rental_blacklist WHERE wa_id=?').get(normalizeWaId(waId));
  if (blocked) throw new Error('Nomor WhatsApp ini tidak dapat menyewa. Hubungi CS jika merasa ini kesalahan.');
  const verification = db.prepare('SELECT location_received, video_received FROM rental_verifications WHERE wa_id=?').get(normalizeWaId(waId));
  if (!verification || !verification.location_received || !verification.video_received) {
    const missing = []; if (!verification || !verification.location_received) missing.push('1. Share Lokasi WhatsApp (lokasi saat ini, bukan live location)'); if (!verification || !verification.video_received) missing.push('2. Video wajah sambil mengucapkan “Rental dulu, Bos”');
    throw new Error(`Sebelum order, kirim ${missing.join(' dan ')} ke bot. Setelah diterima, ulangi perintah SEWA.`);
  }
  const duration = mins(durationMinutes, 60);
  if (duration < 1) throw new Error('Durasi sewa tidak valid.');
  const account = db.prepare(`SELECT * FROM rental_accounts WHERE account_code=? AND active=1`).get(String(accountCode).toUpperCase());
  if (!account) throw new Error('Kode akun tidak ditemukan atau sedang nonaktif.');
  const rentalMode = effectiveRentalMode(account);
  if (rentalMode === 'night') throw new Error(`Akun ${account.account_code} sedang masuk jadwal paket malam (${getSettings().rental_night_start || '21:00'}–${getSettings().rental_night_end || '07:00'} WIB). Gunakan perintah ${account.account_code} MALAM.`);
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
  const uniqueCode = shortUniqueCode();
  const due = new Date(Date.now() + holdMinutes * 60000).toISOString();
  const status = occupied ? 'queued' : 'waiting_payment';
  const transaction = db.transaction(() => {
    const result = db.prepare(`INSERT INTO rental_sessions (rental_code, unique_code, account_id, wa_id, customer_name, duration_minutes, price, status, payment_due_at, queue_position)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`).run(rentalCode, uniqueCode, account.id, waId, customerName, duration, finalPrice, status, due);
    if (!occupied) db.prepare(`UPDATE rental_accounts SET status='reserved', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(account.id);
    updateQueuePositions(account.id);
    return db.prepare('SELECT * FROM rental_sessions WHERE id=?').get(result.lastInsertRowid);
  });
  const rental = transaction();
  audit(waId, 'rental.created', `${rentalCode} account=${account.account_code} status=${status}`);
  return { ...rental, unique_code: uniqueCode, price: finalPrice, account_code: account.account_code, game_code: account.game_code, game_name: account.game_name, queued: occupied };
}
function getRentalByCode(codeValue) {
  return db.prepare(`SELECT r.*, a.account_code, a.game_code, a.game_name, a.login_type, a.login_username, a.login_password, a.status AS account_status
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
  send(active.wa_id, `✅ Pembayaran rental *${active.rental_code}* terkonfirmasi.\n🎮 Akun: *${active.account_code}* (${active.game_name})\n🔑 Metode login: ${active.login_type || 'Email/ID'}\n👤 Username/ID: ${active.login_username}\n🔐 Password: ${active.login_password}\n⏱️ Durasi: ${formatDuration(active.duration_minutes)}\n🕒 Waktu sewa mulai sekarang dan berakhir sekitar ${new Date(active.ends_at).toLocaleString('id-ID',{timeZone:'Asia/Jakarta'})}.\n\nJika tidak bisa login, ketik persis: *AKUN TIDAK BISA DILOGINKAN* dalam 3 menit pertama. Jika tidak ada laporan dalam 3 menit, waktu sewa tetap dihitung dari saat pembayaran terkonfirmasi.`);
  adminNotify(`🔔 *KWENZY | UTAMA — RENTAL ADMIN*\n\n*Waktu mulai:* ${new Date(active.started_at).toLocaleString('id-ID',{timeZone:'Asia/Jakarta'})}\n*Waktu berakhir:* ${new Date(active.ends_at).toLocaleString('id-ID',{timeZone:'Asia/Jakarta'})}\n*Nomor buyer:* ${displayPhone(active.wa_id)}\n*Kode akun:* ${active.account_code}\n*Kode rental:* ${active.rental_code}`);
  audit('system', 'rental.paid', `${codeValue} reference=${reference}`);
  return active;
}
function cancelPendingRental(codeValue, paymentStatus = 'failed') {
  const rental = db.prepare(`SELECT * FROM rental_sessions WHERE rental_code=? AND status='waiting_payment' AND payment_status='pending'`).get(codeValue);
  if (!rental) return false;
  const transaction = db.transaction(() => {
    db.prepare(`UPDATE rental_sessions SET status='cancelled', payment_status=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='waiting_payment' AND payment_status='pending'`).run(paymentStatus, rental.id);
    db.prepare(`UPDATE rental_accounts SET status='available', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='reserved'`).run(rental.account_id);
  });
  transaction();
  send(rental.wa_id, `⌛ Pembayaran rental *${rental.rental_code}* berstatus ${paymentStatus}. Reservasi dibatalkan dan akun akan diteruskan ke antrean berikutnya jika ada.`);
  audit('system', 'rental.payment_cancelled', `${rental.rental_code}:${paymentStatus}`);
  promoteQueue(rental.account_id);
  return true;
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
  const adminNumber = String(getSettings().admin_whatsapp || '').replace(/\D/g, '');
  send(waId, `⚠️ Laporan akun *${rental.account_code}* diterima. Waktu sewa dijeda dan admin diberi tahu. Hubungi owner/CS di sini: ${adminNumber ? `https://wa.me/${adminNumber}` : 'nomor CS belum diatur di panel admin'}. Waktu perbaikan tidak dihitung selama status perbaikan.`);
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
    db.prepare(`UPDATE rental_accounts SET status='maintenance', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(rental.account_id);
    send(rental.wa_id, `⏰ Waktu sewa *${rental.account_code}* telah habis, Bos. Silakan logout dari akun dan kirim rekaman layar sebagai bukti logout. Akun akan diperiksa admin sebelum dinyatakan siap disewakan kembali.`);
    adminNotify(`WAKTU_SELESAI: ${new Date().toLocaleString('id-ID',{timeZone:'Asia/Jakarta'})}\nNOMOR_BUYER: ${displayPhone(rental.wa_id)}\nKODE_AKUN: ${rental.account_code}\nKODE_RENTAL: ${rental.rental_code}\nPelanggan diminta logout dan mengirim rekaman layar.`);
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
function sendFiveMinuteReminders() {
  const now = Date.now();
  const due = db.prepare("SELECT r.*, a.account_code FROM rental_sessions r JOIN rental_accounts a ON a.id=r.account_id WHERE r.status='active' AND r.reminder_5_sent=0 AND r.ends_at <= ? AND r.ends_at > ?").all(new Date(now + 5*60000).toISOString(), new Date(now).toISOString());
  for (const rental of due) {
    db.prepare('UPDATE rental_sessions SET reminder_5_sent=1 WHERE id=? AND reminder_5_sent=0').run(rental.id);
    send(rental.wa_id, `⏰ Bos, sewa *${rental.account_code}* tinggal 5 menit lagi. Mau perpanjang? Balas *PERPANJANG* atau hubungi CS untuk meminta perpanjangan. Tagihan harus diverifikasi sebelum waktu ditambah.`);
  }
}
function recordVerification(waId, type, latitude=null, longitude=null) {
  const id = normalizeWaId(waId); if (!id) throw new Error('Nomor WhatsApp tidak valid.');
  const isLocation = type === 'location';
  db.prepare(`INSERT INTO rental_verifications (wa_id, location_received, video_received, location_latitude, location_longitude) VALUES (?, ?, ?, ?, ?) ON CONFLICT(wa_id) DO UPDATE SET location_received=MAX(rental_verifications.location_received, excluded.location_received), video_received=MAX(rental_verifications.video_received, excluded.video_received), location_latitude=COALESCE(excluded.location_latitude, rental_verifications.location_latitude), location_longitude=COALESCE(excluded.location_longitude, rental_verifications.location_longitude), updated_at=CURRENT_TIMESTAMP`).run(id, isLocation ? 1 : 0, isLocation ? 0 : 1, latitude, longitude);
  audit(id, `rental.verification.${type}`, 'evidence received');
  return db.prepare('SELECT * FROM rental_verifications WHERE wa_id=?').get(id);
}
function addBlacklist(waId, reason, accountCode='', actor='admin') {
  const normalized = normalizeWaId(waId);
  if (!normalized) throw new Error('Nomor WhatsApp wajib diisi.');
  db.prepare("INSERT INTO rental_blacklist (wa_id, reason, account_code, created_by) VALUES (?,?,?,?) ON CONFLICT(wa_id) DO UPDATE SET reason=excluded.reason, account_code=excluded.account_code, created_by=excluded.created_by").run(normalized, String(reason || 'Pelanggaran aturan rental').slice(0,1000), String(accountCode || ''), actor);
  audit(actor, 'rental.blacklist.added', `${normalized}: ${reason}`);
}
function removeBlacklist(waId, actor='admin') { db.prepare('DELETE FROM rental_blacklist WHERE wa_id=?').run(normalizeWaId(waId)); audit(actor, 'rental.blacklist.removed', normalizeWaId(waId)); }
function listBlacklist() { return db.prepare('SELECT * FROM rental_blacklist ORDER BY id DESC').all(); }
function listNightBookings() { return db.prepare(`SELECT n.*,a.account_code,a.game_name FROM rental_night_bookings n JOIN rental_accounts a ON a.id=n.account_id ORDER BY n.id DESC LIMIT 300`).all(); }
function listRentals() {
  return db.prepare(`SELECT r.*, a.account_code, a.game_code, a.game_name, a.status AS account_status
    FROM rental_sessions r JOIN rental_accounts a ON a.id=r.account_id ORDER BY r.id DESC LIMIT 300`).all();
}
function listAccounts() {
  return db.prepare(`SELECT a.*, (SELECT COUNT(*) FROM rental_sessions r WHERE r.account_id=a.id AND r.status IN ('waiting_payment','queued','active','problem')) AS active_rentals FROM rental_accounts a ORDER BY a.game_code, a.account_code`).all().map(a => ({...a, configured_rental_mode:a.rental_mode, rental_mode: effectiveRentalMode(a)}));
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
  const duration = mins(input.duration_minutes ?? (Number(input.duration_hours) * 60), 0);
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
setInterval(() => { try { expirePending(); expireActive(); sendThreeMinuteReminders(); sendFiveMinuteReminders(); notifyNightStart(); expireNightBookings(); expireNightActive(); }  catch (error) { console.error('Rental maintenance error:', error.message); } }, 15_000).unref();

module.exports = { isNightHours, effectiveRentalMode, createAccount, updateAccount, deleteAccount, listAccounts, createRental, createNightBooking, continueNightBooking, getNightBooking, markNightPaid, getNightBookingByOrder, listNightBookings, markRentalPaid, expirePending, cancelPendingRental, reportIssue, resolveIssue, expireActive, listRentals, getRentalPrices, upsertPrice, setMaintenance, addBlacklist, removeBlacklist, listBlacklist, recordVerification };
