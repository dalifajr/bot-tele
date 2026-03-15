const { Markup } = require("telegraf");
const { config } = require("../../config/env");
const {
  getStockSummary,
  getReadyAccounts
} = require("../../services/accountService");
const {
  createOrder,
  getOrderById,
  markOrderPaid,
  getPendingOrders,
  getRevenueSummary
} = require("../../services/orderService");
const { formatCurrencyIdr, formatStockSummary } = require("../../utils/formatters");
const { deliverOrderAccounts } = require("../../services/deliveryService");

const userCheckoutQty = new Map();

function isAdminUser(ctx) {
  return config.adminTelegramIds.includes(String(ctx.from?.id));
}

function renderHelp() {
  return [
    "Perintah user:",
    "/start - menu awal",
    "/produk - lihat produk dan stok",
    "/checkout <qty> - buat order",
    "/status <order_id> - cek status order",
    "/myid - cek telegram id"
  ].join("\n");
}

function getQty(userId) {
  const val = Number(userCheckoutQty.get(userId) || 1);
  if (!Number.isInteger(val) || val <= 0) {
    return 1;
  }
  return val;
}

function setQty(userId, qty) {
  const normalized = Math.max(1, Math.min(50, Number(qty) || 1));
  userCheckoutQty.set(userId, normalized);
  return normalized;
}

function mainMenuKeyboard(isAdmin) {
  const rows = [
    [Markup.button.callback("Lihat Produk", "menu_produk")],
    [Markup.button.callback("Checkout", "menu_checkout")]
  ];

  if (isAdmin) {
    rows.push([Markup.button.callback("Menu Admin", "menu_admin")]);
  }

  return Markup.inlineKeyboard(rows);
}

function checkoutKeyboard(userId) {
  const qty = getQty(userId);
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("-", "checkout_dec"),
      Markup.button.callback(`Qty: ${qty}`, "checkout_qty_noop"),
      Markup.button.callback("+", "checkout_inc")
    ],
    [Markup.button.callback("Buat Order", "checkout_confirm")],
    [Markup.button.callback("Kembali", "menu_back")]
  ]);
}

function adminMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Cek Stok", "admin_btn_stok")],
    [Markup.button.callback("Cek Pending", "admin_btn_pending")],
    [Markup.button.callback("Cek Pendapatan", "admin_btn_pendapatan")],
    [Markup.button.callback("Kembali", "menu_back")]
  ]);
}

async function sendMainMenu(ctx) {
  const stock = getStockSummary();
  const isAdmin = isAdminUser(ctx);
  await ctx.reply(
    [
      `Selamat datang di ${config.storeName}.`,
      `Produk: ${config.productName}`,
      `Harga: ${formatCurrencyIdr(config.productPriceIdr)}`,
      formatStockSummary(stock),
      "",
      isAdmin
        ? "Status: Anda terdeteksi sebagai ADMIN."
        : "Status: Anda terdeteksi sebagai CUSTOMER.",
      "Gunakan tombol di bawah untuk navigasi."
    ].join("\n"),
    mainMenuKeyboard(isAdmin)
  );
}

async function replyOrEdit(ctx, text, keyboard) {
  if (ctx.updateType === "callback_query") {
    try {
      await ctx.editMessageText(text, keyboard ? keyboard : undefined);
      return;
    } catch (error) {
      await ctx.reply(text, keyboard ? keyboard : undefined);
      return;
    }
  }

  await ctx.reply(text, keyboard ? keyboard : undefined);
}

async function createOrderForUser(ctx, quantity) {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    await replyOrEdit(ctx, "Jumlah checkout tidak valid.");
    return;
  }

  const ready = getReadyAccounts();
  if (ready.length < quantity) {
    await replyOrEdit(ctx, "Stok ready tidak cukup untuk jumlah tersebut.", checkoutKeyboard(ctx.from.id));
    return;
  }

  const reserved = ready.slice(0, quantity).map((item) => item.id);

  const order = createOrder({
    telegramId: ctx.from.id,
    quantity,
    reservedAccounts: reserved
  });

  await replyOrEdit(
    ctx,
    [
      `Order dibuat: ${order.id}`,
      `Total: ${formatCurrencyIdr(order.total)}`,
      `Provider: ${order.payment.provider}`,
      `Invoice QRIS: ${order.payment.invoiceUrl}`,
      `QR String: ${order.payment.qrString}`,
      `Expired: ${order.payment.expiresAt}`,
      "",
      "Setelah transfer, tunggu konfirmasi webhook atau gunakan /paid <order_id> untuk simulasi pembayaran."
    ].join("\n")
  );
}

function registerUserHandlers(bot) {
  bot.start(async (ctx) => {
    await sendMainMenu(ctx);
  });

  bot.command("menu", async (ctx) => {
    await sendMainMenu(ctx);
  });

  bot.command("myid", async (ctx) => {
    await ctx.reply(`Telegram ID Anda: ${ctx.from?.id || "unknown"}`);
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

    await createOrderForUser(ctx, quantity);
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

    if (String(order.telegramId) !== String(ctx.from.id)) {
      await ctx.reply("Order ini bukan milik Anda.");
      return;
    }

    await ctx.reply(
      [
        `Order: ${order.id}`,
        `Status: ${order.status}`,
        `Total: ${formatCurrencyIdr(order.total)}`,
        `Invoice: ${order.payment.invoiceUrl}`,
        `Expired: ${order.payment.expiresAt}`,
        `Paid at: ${order.payment.paidAt || "-"}`,
        `Payment ref: ${order.payment.paidReference || "-"}`,
        `Delivery attempts: ${order.delivery && Number.isInteger(order.delivery.attempts) ? order.delivery.attempts : 0}`,
        `Delivery error: ${order.delivery && order.delivery.lastError ? order.delivery.lastError : "-"}`
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

    if (String(order.telegramId) !== String(paidCtx.from.id)) {
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

  bot.action("menu_back", async (ctx) => {
    await ctx.answerCbQuery();
    const stock = getStockSummary();
    const isAdmin = isAdminUser(ctx);
    await replyOrEdit(
      ctx,
      [
        `Selamat datang di ${config.storeName}.`,
        `Produk: ${config.productName}`,
        `Harga: ${formatCurrencyIdr(config.productPriceIdr)}`,
        formatStockSummary(stock),
        "",
        isAdmin
          ? "Status: Anda terdeteksi sebagai ADMIN."
          : "Status: Anda terdeteksi sebagai CUSTOMER."
      ].join("\n"),
      mainMenuKeyboard(isAdmin)
    );
  });

  bot.action("menu_produk", async (ctx) => {
    await ctx.answerCbQuery();
    const stock = getStockSummary();
    await replyOrEdit(
      ctx,
      [
        `Produk: ${config.productName}`,
        `Harga: ${formatCurrencyIdr(config.productPriceIdr)}`,
        `Stok ready: ${stock.readyCount}`,
        `Awaiting benefits: ${stock.awaitingCount}`
      ].join("\n"),
      Markup.inlineKeyboard([[Markup.button.callback("Kembali", "menu_back")]])
    );
  });

  bot.action("menu_checkout", async (ctx) => {
    await ctx.answerCbQuery();
    const current = getQty(ctx.from.id);
    setQty(ctx.from.id, current);
    await replyOrEdit(
      ctx,
      [
        `Checkout ${config.productName}`,
        `Harga satuan: ${formatCurrencyIdr(config.productPriceIdr)}`,
        `Qty: ${getQty(ctx.from.id)}`,
        `Total: ${formatCurrencyIdr(getQty(ctx.from.id) * config.productPriceIdr)}`
      ].join("\n"),
      checkoutKeyboard(ctx.from.id)
    );
  });

  bot.action("checkout_dec", async (ctx) => {
    await ctx.answerCbQuery();
    const next = setQty(ctx.from.id, getQty(ctx.from.id) - 1);
    await replyOrEdit(
      ctx,
      [
        `Checkout ${config.productName}`,
        `Harga satuan: ${formatCurrencyIdr(config.productPriceIdr)}`,
        `Qty: ${next}`,
        `Total: ${formatCurrencyIdr(next * config.productPriceIdr)}`
      ].join("\n"),
      checkoutKeyboard(ctx.from.id)
    );
  });

  bot.action("checkout_inc", async (ctx) => {
    await ctx.answerCbQuery();
    const maxAllowed = Math.max(1, getReadyAccounts().length);
    const next = Math.min(maxAllowed, getQty(ctx.from.id) + 1);
    setQty(ctx.from.id, next);
    await replyOrEdit(
      ctx,
      [
        `Checkout ${config.productName}`,
        `Harga satuan: ${formatCurrencyIdr(config.productPriceIdr)}`,
        `Qty: ${next}`,
        `Total: ${formatCurrencyIdr(next * config.productPriceIdr)}`,
        `Stok ready saat ini: ${getReadyAccounts().length}`
      ].join("\n"),
      checkoutKeyboard(ctx.from.id)
    );
  });

  bot.action("checkout_qty_noop", async (ctx) => {
    await ctx.answerCbQuery("Gunakan tombol - / + untuk ubah qty");
  });

  bot.action("checkout_confirm", async (ctx) => {
    await ctx.answerCbQuery();
    await createOrderForUser(ctx, getQty(ctx.from.id));
  });

  bot.action("menu_admin", async (ctx) => {
    if (!isAdminUser(ctx)) {
      await ctx.answerCbQuery("Anda bukan admin", { show_alert: true });
      return;
    }

    await ctx.answerCbQuery();
    await replyOrEdit(
      ctx,
      [
        "Panel Admin",
        "Pilih aksi cepat di bawah.",
        "Untuk aksi lanjutan tetap bisa pakai command /admin"
      ].join("\n"),
      adminMenuKeyboard()
    );
  });

  bot.action("admin_btn_stok", async (ctx) => {
    if (!isAdminUser(ctx)) {
      await ctx.answerCbQuery("Anda bukan admin", { show_alert: true });
      return;
    }

    await ctx.answerCbQuery();
    const stock = getStockSummary();
    await replyOrEdit(
      ctx,
      [
        "Panel stok:",
        `Ready: ${stock.readyCount}`,
        `Awaiting benefits: ${stock.awaitingCount}`,
        `Sold: ${stock.soldCount}`,
        `Sold (coupon applied): ${stock.appliedSoldCount}`
      ].join("\n"),
      adminMenuKeyboard()
    );
  });

  bot.action("admin_btn_pending", async (ctx) => {
    if (!isAdminUser(ctx)) {
      await ctx.answerCbQuery("Anda bukan admin", { show_alert: true });
      return;
    }

    await ctx.answerCbQuery();
    const pending = getPendingOrders();
    await replyOrEdit(
      ctx,
      `Total pending transaksi: ${pending.length}`,
      adminMenuKeyboard()
    );
  });

  bot.action("admin_btn_pendapatan", async (ctx) => {
    if (!isAdminUser(ctx)) {
      await ctx.answerCbQuery("Anda bukan admin", { show_alert: true });
      return;
    }

    await ctx.answerCbQuery();
    const summary = getRevenueSummary();
    await replyOrEdit(
      ctx,
      [
        "Ringkasan pendapatan:",
        `Order dibayar: ${summary.paidOrderCount}`,
        `Total pendapatan: ${formatCurrencyIdr(summary.totalRevenue)}`
      ].join("\n"),
      adminMenuKeyboard()
    );
  });
}

module.exports = {
  registerUserHandlers
};
