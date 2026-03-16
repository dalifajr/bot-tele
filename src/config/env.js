const path = require("path");
const dotenv = require("dotenv");

dotenv.config();

function parseAdminIds(raw) {
  if (!raw) {
    return [];
  }

  return raw
    .split(",")
    .map((v) => v.trim())
    .filter((v) => /^\d+$/.test(v));
}

const config = {
  botToken: process.env.TELEGRAM_BOT_TOKEN || "",
  adminTelegramIds: parseAdminIds(process.env.ADMIN_TELEGRAM_IDS),
  storeName: process.env.STORE_NAME || "digital store",
  productName: process.env.PRODUCT_NAME || "GitHub Students Dev Pack",
  productPriceIdr: Number(process.env.PRODUCT_PRICE_IDR || 150000),
  dataDir: process.env.DATA_DIR || path.join(process.cwd(), "data"),
  invoiceExpireMinutes: Number(process.env.INVOICE_EXPIRE_MINUTES || 30),
  appPort: Number(process.env.APP_PORT || 3000),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || "http://localhost:3000",
  displayTimezone: process.env.DISPLAY_TIMEZONE || "Asia/Jakarta",
  qrisProvider: process.env.QRIS_PROVIDER || "SIMULATED",
  paymentWebhookSecret: process.env.PAYMENT_WEBHOOK_SECRET || "dev-secret",
  lowStockThreshold: Number(process.env.LOW_STOCK_THRESHOLD || 3)
};

module.exports = { config };
