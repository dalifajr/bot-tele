# BOT TELE Digital Store

Telegram bot untuk penjualan produk digital dengan flow:
- User lihat stok produk
- User checkout banyak akun sekaligus
- Bot membuat order + invoice QRIS (mode simulasi)
- Pembayaran terkonfirmasi mengirim detail akun otomatis
- Admin mengelola stok, status benefit, transaksi, dan pencarian akun

Dokumen ini fokus pada instalasi production Ubuntu 20.04+.

## Fitur yang sudah ada

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
STORE_NAME=dzulfikrialifajri store
PRODUCT_NAME=GitHub Students Dev Pack
PRODUCT_PRICE_IDR=150000
DATA_DIR=./data
INVOICE_EXPIRE_MINUTES=30
APP_PORT=3000
PUBLIC_BASE_URL=http://localhost:3000
QRIS_PROVIDER=SIMULATED
PAYMENT_WEBHOOK_SECRET=change-me
```

Catatan:
- `ADMIN_TELEGRAM_IDS` bisa lebih dari satu, pisahkan dengan koma.
- `PAYMENT_WEBHOOK_SECRET` wajib diganti di production.
- Simpan file `.env`, jangan commit ke git.

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

## Daftar command

User:
- `/start`
- `/produk`
- `/checkout <qty>`
- `/status <order_id>`
- `/paid <order_id>` (simulasi konfirmasi pembayaran)

Admin:
- `/admin_stok`
- `/admin_pending`
- `/admin_pendapatan`
- `/admin_cari <username>`
- `/admin_tambah <blok akun>`
- `/admin_set_status <username> <awaiting|ready|applied>`
- `/admin_parse_benefit <username>`

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

## Utility script

- `npm run check:data`: validasi file data
- `npm run migrate:accounts`: migrasi format teks akun ke JSON

## Catatan production

- Integrasi QRIS masih mode simulasi. Hubungkan ke provider nyata (misalnya Xendit/Tripay) melalui endpoint webhook yang sudah ada.
- Pengecekan benefit GitHub otomatis saat ini berupa reminder + notifikasi status yang sudah diupdate di data bot. Proses login/check per akun GitHub belum diaktifkan otomatis.
- Sebelum live, pastikan kebijakan platform dan keamanan kredensial akun sudah sesuai risiko operasional Anda.
