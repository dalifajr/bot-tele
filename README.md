# BOT TELE Digital Store

Telegram bot untuk penjualan produk digital dengan flow:
- User lihat stok produk
- User checkout banyak akun sekaligus
- Bot membuat order + invoice QRIS (mode simulasi)
- Pembayaran terkonfirmasi mengirim detail akun otomatis
- Admin mengelola stok, status benefit, transaksi, dan pencarian akun

Dokumen ini fokus pada instalasi production Ubuntu 20.04+.

## Fitur yang sudah ada

- Menu berbasis tombol (inline keyboard) untuk alur utama user
- Checkout dengan tombol `-` dan `+` untuk atur quantity
- Tombol `Menu Admin` otomatis tampil untuk Telegram ID admin terdaftar
- Wizard admin berbasis tombol untuk cari akun dan tambah akun
- Menu `Daftar Akun` admin: pilih source `awaiting`/`ready`/`sold`, klik akun untuk lihat detail lengkap, lalu ubah status via tombol
- Pada detail akun tersedia tombol `Hapus` untuk menghapus akun dari source terkait
- Tombol `Hapus` kini menggunakan konfirmasi 2 langkah (Ya, Hapus / Batal)
- Daftar akun admin sudah menggunakan pagination (Prev/Next), 10 akun per halaman
- Menu `Ubah Status Akun Masal` untuk perubahan status banyak akun berdasarkan akun yang dipilih (tidak semua)
- Menu `Cek Pendapatan` sekarang menyediakan tombol `Reset Pendapatan` (dengan konfirmasi)
- Notifikasi admin otomatis saat order baru dibuat
- Notifikasi admin saat order selesai dikirim beserta nominal pendapatan order
- Notifikasi stok ready menipis dan notifikasi restock/pulih berdasarkan threshold
- Menu `Broadcast` admin ke semua pelanggan yang pernah interaksi ke bot (non-admin)
- Flow user: `/start`, `/produk`, `/checkout <qty>`, `/status <order_id>`
- Flow admin: cek stok, cek pending, cek pendapatan, tambah akun, cari akun, ubah status benefit
- Webhook pembayaran HMAC untuk menandai order `PAID`
- Pengiriman akun otomatis ke pembeli saat status pembayaran valid
- Scheduler harian untuk notifikasi ringkasan stok + reminder pengecekan benefit
- Idempotency webhook pembayaran (duplikasi callback tidak memproses order dua kali)
- Expiry order otomatis berdasarkan `INVOICE_EXPIRE_MINUTES`

## Kebutuhan sistem

- Ubuntu 20.04 atau lebih baru
- RAM minimal 4 GB
- Node.js 18+ (disarankan Node.js 20)
- Akses internet stabil untuk Telegram API

## Instalasi cepat (Ubuntu)

Single-line install (prepare dependency + clone + install):

sudo apt-get update -y && sudo apt-get install -y git curl ca-certificates && git clone https://github.com/dalifajr/bot-tele.git /opt/bot-tele && cd /opt/bot-tele && chmod +x setup.sh && ./setup.sh

Jika folder `/opt/bot-tele` sudah ada, gunakan single-line update + install:

cd /opt/bot-tele && git pull --ff-only && chmod +x setup.sh && ./setup.sh

Di root project, jalankan:

```bash
chmod +x setup.sh
./setup.sh
```

Script ini akan:
- Install Node.js 20
- Install dependency project
- Membuat `.env` dari `.env.example`
- Menjalankan validasi/migrasi data awal
- Menyiapkan command panel maintenance `panel`

## Panel menu server (Ubuntu)

Untuk memudahkan setting dan maintenance, setelah instalasi cukup jalankan:

```bash
panel
```

Menu panel menyediakan:
- Setup konfigurasi dasar `.env`
- Edit `.env` manual
- Install/update dependency
- Validasi dan migrasi data akun
- Install dan kontrol service `bot-tele.service` (start/stop/restart/status)
- Lihat log service (last/realtime)
- Health check endpoint `/health`
- Backup data (`list_akun_ready.json`, `awaiting_benefits.json`, `terjual.json`, `data`, `.env`)
- Update project dari git (`git pull --ff-only`)

Panel ini dirancang untuk server dengan systemd (Ubuntu production).

Catatan:
- Panel sekarang menyatu dalam `setup.sh` (mode panel).
- Command global `panel` otomatis dibuat ke `/usr/local/bin/panel` saat instalasi selesai.

## Instalasi manual (opsional)

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
npm install
cp .env.example .env
```

Lalu edit nilai di `.env`.

## Konfigurasi environment

Template ada di `.env.example`:

```env
TELEGRAM_BOT_TOKEN=
ADMIN_TELEGRAM_IDS=123456789
WHATSAPP_ENABLED=false
ADMIN_WHATSAPP_NUMBERS=628123456789
WHATSAPP_PUPPETEER_EXECUTABLE_PATH=
STORE_NAME=dzulfikrialifajri store
PRODUCT_NAME=GitHub Students Dev Pack
PRODUCT_PRICE_IDR=150000
DATA_DIR=./data
INVOICE_EXPIRE_MINUTES=30
APP_PORT=3000
PUBLIC_BASE_URL=http://localhost:3000
DISPLAY_TIMEZONE=Asia/Jakarta
QRIS_PROVIDER=SIMULATED
PAYMENT_WEBHOOK_SECRET=change-me
LOW_STOCK_THRESHOLD=3
```

Catatan:
- `ADMIN_TELEGRAM_IDS` bisa lebih dari satu, pisahkan dengan koma.
- `ADMIN_WHATSAPP_NUMBERS` bisa lebih dari satu, pisahkan dengan koma (format angka tanpa simbol, contoh `628123456789`).
- `WHATSAPP_ENABLED=true` untuk menjalankan bot WhatsApp.
- `WHATSAPP_PUPPETEER_EXECUTABLE_PATH` opsional untuk pakai binary Chrome/Chromium sistem (contoh `/usr/bin/chromium-browser`).
- `PAYMENT_WEBHOOK_SECRET` wajib diganti di production.
- `LOW_STOCK_THRESHOLD` menentukan batas stok ready yang dianggap menipis.
- `DISPLAY_TIMEZONE` mengatur zona waktu tampilan pesan bot (default WIB / Asia/Jakarta).
- Simpan file `.env`, jangan commit ke git.

Catatan timestamp:
- Data timestamp tetap disimpan dalam UTC ISO pada storage internal.
- Tampilan waktu pada pesan order, status order, detail akun, dan reset pendapatan ditampilkan dalam WIB.

Catatan perilaku webhook:
- Callback dengan `paymentReference` yang sama akan dianggap duplikat dan diabaikan.
- Order yang sudah `EXPIRED`, `CANCELLED`, atau status non-payable lain tidak akan diproses ulang sebagai pembayaran baru.
## Menjalankan bot

```bash
npm start
```

Untuk pengembangan:

```bash
npm run dev
```

Untuk menjalankan versi WhatsApp:

```bash
npm run start:wa
```

Untuk development mode WhatsApp:

```bash
npm run dev:wa
```

Catatan WhatsApp:
- Bot menggunakan `whatsapp-web.js` dengan login QR (scan QR di terminal saat pertama kali).
- Session login WhatsApp disimpan lokal via `LocalAuth`.
- Version WhatsApp saat ini fokus command text (tanpa inline button seperti Telegram).
- Command admin WhatsApp yang tersedia: `/admin`, `/admin_stok`, `/admin_pending`, `/admin_pendapatan`, `/admin_reset_pendapatan`, `/admin_cari`, `/admin_tambah`, `/admin_set_status`, `/admin_broadcast`.
- Jika muncul error library Chromium (contoh `libatk-1.0.so.0`), install dependency sistem:

```bash
sudo apt-get update -y
sudo apt-get install -y \
  ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 \
  libcups2 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libgtk-3-0 libnspr4 \
  libnss3 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxdamage1 libxext6 \
  libxfixes3 libxrandr2 xdg-utils
```

## Daftar command

User:
- `/start`
- `/menu`
- `/produk`
- `/checkout <qty>`
- `/status <order_id>`
- `/paid <order_id>` (simulasi konfirmasi pembayaran)
- `/myid`

Admin:
- `/admin` (ringkasan menu admin)
- `/admin_stok`
- `/admin_pending`
- `/admin_pendapatan`
- `/admin_reset_pendapatan`
- `/admin_cari <username>`
- `/admin_tambah <blok akun>`
- `/admin_set_status <username> <awaiting|ready>` (opsional via command)
- `/admin_parse_benefit <username>` (opsional via command)

Alur admin via tombol:
- Dari `/start` klik `Menu Admin`
- Pilih aksi cepat: cek stok, cek pending, cek pendapatan
- Di menu `Cek Pendapatan`, admin bisa reset laporan periode aktif tanpa menghapus histori order
- Gunakan `Daftar Akun` untuk melihat list akun awaiting/ready/sold (dengan pagination) lalu klik akun untuk detail + tombol ubah status
- Pada detail akun tersedia tombol `Set Terjual` untuk memindahkan akun ke `terjual.json`
- Gunakan `Ubah Status Akun Masal` untuk memilih beberapa akun tertentu lalu ubah status sekaligus
- Di mode mass status tersedia tombol `Pilih Semua` untuk memilih seluruh akun pada source terpilih
- Gunakan `Broadcast` untuk kirim pesan massal ke pelanggan yang pernah interaksi
- Untuk aksi input, gunakan tombol:
  - `Cari Akun` lalu kirim keyword
  - `Tambah Akun` lalu kirim blok akun sesuai format
  - `Broadcast` lalu kirim isi pesan

Notifikasi otomatis ke admin:
- Order baru dibuat (order id, customer id, qty, total)
- Order selesai diproses/dikirim (order id, customer id, nominal pendapatan)
- Stok ready menipis saat menyentuh threshold
- Stok ready restock/pulih saat naik kembali di atas threshold

## Webhook pembayaran

Server webhook berjalan pada `APP_PORT` dengan endpoint:
- `GET /health`
- `POST /webhook/payment`

Header wajib:
- `x-signature: <hmac_sha256(raw_body, PAYMENT_WEBHOOK_SECRET)>`

Payload contoh:

```json
{
  "orderId": "ORD-20260315-ABCDEFGH",
  "status": "PAID",
  "paymentReference": "PAY-REF-12345"
}
```

Contoh hitung signature di Linux:

```bash
BODY='{"orderId":"ORD-20260315-ABCDEFGH","status":"PAID","paymentReference":"PAY-REF-12345"}'
echo -n "$BODY" | openssl dgst -sha256 -hmac "change-me" | sed 's/^.* //'
```

## Menjalankan sebagai service (systemd)

Buat file service:

```bash
sudo tee /etc/systemd/system/bot-tele.service > /dev/null <<'EOF'
[Unit]
Description=BOT TELE Digital Store
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/bot-tele
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5
User=ubuntu
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
```

Aktifkan service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable bot-tele
sudo systemctl start bot-tele
sudo systemctl status bot-tele
```

Lihat log realtime:

```bash
sudo journalctl -u bot-tele -f
```

## Struktur data utama

- `list_akun_ready.json`: akun siap jual
- `awaiting_benefits.json`: akun menunggu coupon applied
- `terjual.json`: akun terjual
- `data/orders.json`: data order dan status pembayaran
- `data/revenue_reset_state.json`: baseline waktu reset laporan pendapatan
- `data/customers.json`: daftar pelanggan yang pernah interaksi (untuk audience broadcast)
- `data/stock_alert_state.json`: state internal notifikasi stok menipis/restock

## Utility script

- `npm run check:data`: validasi file data
- `npm run migrate:accounts`: migrasi format teks akun ke JSON

## Catatan production

- Integrasi QRIS masih mode simulasi. Hubungkan ke provider nyata (misalnya Xendit/Tripay) melalui endpoint webhook yang sudah ada.
- Pengecekan benefit GitHub otomatis saat ini berupa reminder + notifikasi status yang sudah diupdate di data bot. Proses login/check per akun GitHub belum diaktifkan otomatis.
- Sebelum live, pastikan kebijakan platform dan keamanan kredensial akun sudah sesuai risiko operasional Anda.
