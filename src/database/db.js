const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// Keep session and application data under one persistent root by default.
// DATA_DIR remains supported for existing deployments that explicitly set it.
const storageDirectory = path.resolve(process.env.STORAGE_DIR || './storage');
const dataDirectory = path.resolve(process.env.DATA_DIR || path.join(storageDirectory, 'data'));
fs.mkdirSync(dataDirectory, { recursive: true });

const db = new Database(path.join(dataDirectory, 'obsidian.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku TEXT UNIQUE,
    name TEXT NOT NULL,
    category TEXT DEFAULT '',
    description TEXT DEFAULT '',
    price INTEGER NOT NULL DEFAULT 0,
    promo_price INTEGER,
    stock INTEGER,
    unlimited_stock INTEGER NOT NULL DEFAULT 0,
    image_url TEXT DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wa_id TEXT NOT NULL UNIQUE,
    name TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wa_id TEXT NOT NULL UNIQUE,
    customer_id INTEGER,
    mode TEXT NOT NULL DEFAULT 'ai',
    assigned_to TEXT DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(customer_id) REFERENCES customers(id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wa_id TEXT NOT NULL,
    direction TEXT NOT NULL,
    sender TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL,
    message_id TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_code TEXT NOT NULL UNIQUE,
    wa_id TEXT NOT NULL,
    customer_name TEXT DEFAULT '',
    items_json TEXT NOT NULL,
    subtotal INTEGER NOT NULL,
    total INTEGER NOT NULL,
    payment_method TEXT DEFAULT '',
    payment_status TEXT NOT NULL DEFAULT 'pending',
    order_status TEXT NOT NULL DEFAULT 'new',
    payment_reference TEXT DEFAULT '',
    payment_url TEXT DEFAULT '',
    payment_qr TEXT DEFAULT '',
    expires_at TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS rental_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_code TEXT NOT NULL UNIQUE,
    game_code TEXT NOT NULL,
    game_name TEXT NOT NULL DEFAULT '',
    login_type TEXT NOT NULL DEFAULT 'Email/ID',
    login_username TEXT NOT NULL,
    login_password TEXT NOT NULL,
    notes TEXT DEFAULT '',
    photos_json TEXT DEFAULT '[]',
    rental_mode TEXT NOT NULL DEFAULT 'hourly',
    status TEXT NOT NULL DEFAULT 'available',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS rental_prices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_code TEXT NOT NULL,
    duration_minutes INTEGER NOT NULL,
    price INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    custom_duration_enabled INTEGER NOT NULL DEFAULT 1,
    UNIQUE(game_code, duration_minutes)
  );

  CREATE TABLE IF NOT EXISTS rental_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rental_code TEXT NOT NULL UNIQUE,
    unique_code TEXT DEFAULT '',
    reminder_5_sent INTEGER NOT NULL DEFAULT 0,
    account_id INTEGER NOT NULL,
    wa_id TEXT NOT NULL,
    customer_name TEXT DEFAULT '',
    duration_minutes INTEGER NOT NULL,
    price INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'waiting_payment',
    payment_status TEXT NOT NULL DEFAULT 'pending',
    payment_method TEXT DEFAULT 'static',
    payment_reference TEXT DEFAULT '',
    payment_url TEXT DEFAULT '',
    payment_token TEXT DEFAULT '',
    payment_due_at TEXT NOT NULL,
    paid_at TEXT DEFAULT '',
    started_at TEXT DEFAULT '',
    ends_at TEXT DEFAULT '',
    paused_at TEXT DEFAULT '',
    paused_seconds INTEGER NOT NULL DEFAULT 0,
    issue_reported_at TEXT DEFAULT '',
    issue_note TEXT DEFAULT '',
    issue_reminder_sent INTEGER NOT NULL DEFAULT 0,
    queue_position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(account_id) REFERENCES rental_accounts(id)
  );

  CREATE INDEX IF NOT EXISTS idx_rental_sessions_account_status ON rental_sessions(account_id, status);
  CREATE INDEX IF NOT EXISTS idx_rental_sessions_due ON rental_sessions(status, payment_due_at);

  CREATE TABLE IF NOT EXISTS rental_night_bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_code TEXT NOT NULL UNIQUE,
    dp_order_code TEXT NOT NULL UNIQUE,
    balance_order_code TEXT DEFAULT '',
    account_id INTEGER NOT NULL,
    wa_id TEXT NOT NULL,
    customer_name TEXT DEFAULT '',
    total_price INTEGER NOT NULL,
    dp_amount INTEGER NOT NULL,
    balance_amount INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'awaiting_dp',
    payment_status TEXT NOT NULL DEFAULT 'pending_dp',
    dp_reference TEXT DEFAULT '',
    balance_reference TEXT DEFAULT '',
    dp_url TEXT DEFAULT '',
    balance_url TEXT DEFAULT '',
    due_at TEXT DEFAULT '',
    notified_start INTEGER NOT NULL DEFAULT 0,
    reminder_5_sent INTEGER NOT NULL DEFAULT 0,
    started_at TEXT DEFAULT '',
    ends_at TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(account_id) REFERENCES rental_accounts(id)
  );
  CREATE INDEX IF NOT EXISTS idx_night_booking_status ON rental_night_bookings(status, due_at);

  CREATE TABLE IF NOT EXISTS rental_verifications (
    wa_id TEXT PRIMARY KEY,
    location_received INTEGER NOT NULL DEFAULT 0,
    video_received INTEGER NOT NULL DEFAULT 0,
    location_latitude REAL,
    location_longitude REAL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS rental_blacklist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wa_id TEXT NOT NULL UNIQUE,
    reason TEXT NOT NULL,
    account_code TEXT DEFAULT '',
    created_by TEXT DEFAULT 'admin',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    details TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_messages_wa_id_id ON messages(wa_id, id);
  CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(payment_status, order_status);
`);

// Backward-compatible schema migrations for existing persistent SQLite databases.
function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
ensureColumn('rental_accounts', 'login_type', "TEXT NOT NULL DEFAULT 'Email/ID'");
ensureColumn('rental_prices', 'custom_duration_enabled', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('rental_sessions', 'payment_url', "TEXT DEFAULT ''");
ensureColumn('rental_sessions', 'payment_token', "TEXT DEFAULT ''");
ensureColumn('rental_sessions', 'unique_code', "TEXT DEFAULT ''");
ensureColumn('rental_sessions', 'reminder_5_sent', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('rental_accounts', 'photos_json', "TEXT DEFAULT '[]'");
ensureColumn('rental_accounts', 'rental_mode', "TEXT NOT NULL DEFAULT 'hourly'");
ensureColumn('rental_night_bookings', 'reminder_5_sent', 'INTEGER NOT NULL DEFAULT 0');

// Older panel versions accidentally saved a tariff entered as 1 hour as 1 minute.
// Repair those legacy rows to 60 minutes (the database keeps minutes internally).
const legacyMinuteRates = db.prepare('SELECT * FROM rental_prices WHERE duration_minutes > 0 AND duration_minutes < 60').all();
for (const row of legacyMinuteRates) {
  const correctHour = db.prepare('SELECT id FROM rental_prices WHERE game_code=? AND duration_minutes=60').get(row.game_code);
  if (correctHour) {
    db.prepare('DELETE FROM rental_prices WHERE id=?').run(row.id);
  } else {
    db.prepare('UPDATE rental_prices SET duration_minutes=60 WHERE id=?').run(row.id);
  }
}

const defaults = {
  business_name: 'Obsidian Stack',
  business_description: 'Selamat datang! Kami siap membantu.',
  business_hours: 'Setiap hari, 09.00–17.00',
  welcome_message: 'Halo,\nSelamat datang di {business}. Ada yang bisa kami bantu bos?',
  menu_text: '*Silakan pilih dulu boss:*\n1. Rental akun game (ketik RENTAL)\n2. Lihat produk & Layanan (ketik LIHAT)\n3. Cara pembayaran (ketik CARA BAYAR)\n4. Butuh bantuan (ketik CS)',
  admin_whatsapp: '',
  ai_enabled: '1',
  ai_provider: 'openrouter',
  openrouter_api_key: process.env.OPENROUTER_API_KEY || '',
  openrouter_model: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free',
  openrouter_site_url: process.env.OPENROUTER_SITE_URL || '',
  openrouter_app_name: process.env.OPENROUTER_APP_NAME || 'Obsidian Stack WhatsApp AI',
  ai_system_prompt: 'Kamu adalah customer service yang ramah, akurat, dan ringkas. Gunakan hanya data bisnis yang diberikan. Jangan mengarang harga, stok, status pembayaran, atau kebijakan. Jika tidak yakin, tawarkan untuk menghubungkan pelanggan dengan admin. Untuk pembelian, arahkan pelanggan melihat produk dan konfirmasi pesanan sebelum membuat tagihan.',
  static_qris_image: '',
  static_qris_instructions: 'Scan QRIS berikut melalui aplikasi pembayaran kamu. Jika sudah membayar, mohon tunggu verifikasi transaksi dari admin.',
  payment_provider_name: '',
  payment_create_url: '',
  payment_status_url: '',
  payment_api_key: '',
  payment_merchant_id: '',
  payment_mode: 'sandbox',
  payment_dynamic_enabled: '0',
  payment_webhook_secret: process.env.PAYMENT_WEBHOOK_SECRET || '',
  payment_expiry_minutes: '15',
  currency: 'IDR',
  human_handover_message: 'Baik, permintaan kamu sudah diteruskan ke customer service. Mohon tunggu sebentar ya.',
  auto_reply_enabled: '1',
  sticker_spam_enabled: '1',
};

const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [key, value] of Object.entries(defaults)) {
  insertSetting.run(key, String(value));
}

function getSettings() {
  return Object.fromEntries(
    db.prepare('SELECT key, value FROM settings').all().map(({ key, value }) => [key, value]),
  );
}

function setSettings(values) {
  const statement = db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  const transaction = db.transaction((entries) => {
    for (const [key, value] of Object.entries(entries)) {
      statement.run(key, String(value ?? ''));
    }
  });
  transaction(values);
}

function audit(actor, action, details = '') {
  db.prepare('INSERT INTO audit_log (actor, action, details) VALUES (?, ?, ?)')
    .run(actor, action, String(details).slice(0, 2000));
}

module.exports = { db, getSettings, setSettings, audit };
