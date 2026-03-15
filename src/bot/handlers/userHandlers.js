const { config } = require("../../config/env");
const {
  getStockSummary,
  getReadyAccounts
} = require("../../services/accountService");
const {
  createOrder,
  getOrderById,
  markOrderPaid
} = require("../../services/orderService");
const { formatCurrencyIdr, formatStockSummary } = require("../../utils/formatters");
const { deliverOrderAccounts } = require("../../services/deliveryService");

function renderHelp() {
  return [
    "Perintah user:",
    "/start - menu awal",
    "/produk - lihat produk dan stok",
    "/checkout <qty> - buat order",
    "/status <order_id> - cek status order"
  ].join("\n");
}

function registerUserHandlers(bot) {
  bot.start(async (ctx) => {
    const stock = getStockSummary();
    await ctx.reply(
      [
        `Selamat datang di ${config.storeName}.`,
        `Produk: ${config.productName}`,
        `Harga: ${formatCurrencyIdr(config.productPriceIdr)}`,
        formatStockSummary(stock),
        "",
        renderHelp()
      ].join("\n")
    );
  });

  bot.command("produk", async (ctx) => {
    const stock = getStockSummary();
    await ctx.reply(
      [
        `Produk: ${config.productName}`,
        `Harga: ${formatCurrencyIdr(config.productPriceIdr)}`,
        `Stok ready: ${stock.readyCount}`,
        `Awaiting benefits: ${stock.awaitingCount}`,
        "",
        "Checkout contoh: /checkout 2"
      ].join("\n")
    );
  });

  bot.command("checkout", async (ctx) => {
    const [_, qtyText] = String(ctx.message?.text || "").split(" ");
    const quantity = Number(qtyText);

    if (!Number.isInteger(quantity) || quantity <= 0) {
      await ctx.reply("Masukkan jumlah valid. Contoh: /checkout 1");
      return;
    }

    const ready = getReadyAccounts();
    if (ready.length < quantity) {
      await ctx.reply("Stok ready tidak cukup untuk jumlah tersebut.");
      return;
    }

    const reserved = ready.slice(0, quantity).map((item) => item.id);

    const order = createOrder({
      telegramId: ctx.from.id,
      quantity,
      reservedAccounts: reserved
    });

    await ctx.reply(
      [
        `Order dibuat: ${order.id}`,
        `Total: ${formatCurrencyIdr(order.total)}`,
        `Provider: ${order.payment.provider}`,
        `Invoice QRIS: ${order.payment.invoiceUrl}`,
        `QR String: ${order.payment.qrString}`,
        `Expired: ${order.payment.expiresAt}`,
        "",
        "MVP note: setelah transfer, gunakan /paid <order_id> untuk simulasi konfirmasi atau webhook /webhook/payment."
      ].join("\n")
    );
  });

  bot.command("status", async (ctx) => {
    const [_, orderId] = String(ctx.message?.text || "").split(" ");
    if (!orderId) {
      await ctx.reply("Gunakan: /status <order_id>");
      return;
    }

    const order = getOrderById(orderId);
    if (!order) {
      await ctx.reply("Order tidak ditemukan.");
      return;
    }

    if (Number(order.telegramId) !== Number(ctx.from.id)) {
      await ctx.reply("Order ini bukan milik Anda.");
      return;
    }

    await ctx.reply(
      [
        `Order: ${order.id}`,
        `Status: ${order.status}`,
        `Total: ${formatCurrencyIdr(order.total)}`,
        `Invoice: ${order.payment.invoiceUrl}`,
        `Expired: ${order.payment.expiresAt}`
      ].join("\n")
    );
  });

  bot.command("paid", async (paidCtx) => {
    const [_, orderId] = String(paidCtx.message?.text || "").split(" ");
    if (!orderId) {
      await paidCtx.reply("Gunakan: /paid <order_id>");
      return;
    }

    const order = getOrderById(orderId);
    if (!order) {
      await paidCtx.reply("Order tidak ditemukan.");
      return;
    }

    if (Number(order.telegramId) !== Number(paidCtx.from.id)) {
      await paidCtx.reply("Order ini bukan milik Anda.");
      return;
    }

    const paid = markOrderPaid(order.id);
    if (!paid) {
      await paidCtx.reply("Gagal update status order.");
      return;
    }

    const delivery = await deliverOrderAccounts(bot, paid);
    if (!delivery.ok) {
      await paidCtx.reply("Akun untuk order ini sudah tidak tersedia. Hubungi admin.");
    }
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(renderHelp());
  });
}

module.exports = {
  registerUserHandlers
};
