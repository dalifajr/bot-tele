# BOT TELE Digital Store (MVP)

MVP Telegram bot untuk flow jual produk digital:
- User lihat produk dan stok
- User checkout jumlah akun
- Bot buat order + invoice QRIS (placeholder)
- Admin bisa tambah stok, cek pendapatan, cek pending, cari akun

## Menjalankan

1. Install dependency:
   npm install
2. Copy konfigurasi:
   cp .env.example .env
3. Isi nilai pada `.env`
4. Jalankan bot:
   npm start

## Command yang tersedia

- User:
   - `/start`
   - `/produk`
   - `/checkout <qty>`
   - `/status <order_id>`
   - `/paid <order_id>` (simulasi konfirmasi pembayaran)
- Admin:
   - `/admin_stok`
   - `/admin_pending`
   - `/admin_pendapatan`
   - `/admin_cari <username>`
   - `/admin_tambah <blok akun>`
   - `/admin_set_status <username> <awaiting|ready|applied>`
   - `/admin_parse_benefit <username>` (deteksi status dari benefit.html)

## Webhook pembayaran (MVP)

Bot menjalankan HTTP server pada `APP_PORT` dengan endpoint:

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

Jika valid dan status `PAID`, bot akan menandai order lunas lalu otomatis mengirim file akun ke pembeli.

## Struktur data

- `list_akun_ready.json`: akun siap jual
- `awaiting_benefits.json`: akun menunggu coupon applied
- `terjual.json`: akun sudah terjual
- `data/orders.json`: catatan order

## Catatan penting

Integrasi QRIS pada MVP ini masih menggunakan placeholder endpoint agar flow bot bisa diuji dulu. Ganti dengan provider QRIS asli (misalnya Xendit/Tripay) pada tahap berikutnya.

Pengecekan status coupon GitHub otomatis saat ini masih berupa reminder scheduler harian ke admin. Integrasi login/check status per akun perlu ditambahkan pada tahap berikutnya dengan kebijakan keamanan yang ketat.
