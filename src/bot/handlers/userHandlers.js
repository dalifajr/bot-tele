const { Markup } = require("telegraf");
const { config } = require("../../config/env");
const {
  getStockSummary,
  getReadyAccounts,
  getAwaitingAccounts,
  addReadyAccount,
  findByUsername,
  getAccountById,
  moveAccountToSoldById,
  upsertBenefitStatusById,
  upsertBenefitStatusByUsername,
  BENEFIT_STATUS
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
const { detectBenefitStatusFromSnapshotFile } = require("../../services/benefitHtmlService");

const userCheckoutQty = new Map();
const adminInputState = new Map();

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
    [Markup.button.callback("Daftar Akun", "admin_btn_list_accounts")],
    [Markup.button.callback("Bulk Cek Awaiting", "admin_btn_bulk_check_awaiting")],
    [Markup.button.callback("Cari Akun", "admin_btn_cari")],
    [Markup.button.callback("Tambah Akun", "admin_btn_tambah")],
    [Markup.button.callback("Set Status", "admin_btn_set_status")],
    [Markup.button.callback("Parse Benefit", "admin_btn_parse_benefit")],
    [Markup.button.callback("Kembali", "menu_back")]
  ]);
}

function accountListSourceKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Awaiting", "admin_list_src_awaiting")],
    [Markup.button.callback("Ready", "admin_list_src_ready")],
    [Markup.button.callback("Kembali", "menu_admin")]
  ]);
}

function shortAccountLabel(account) {
  const username = String(account.username || "-");
  const status = String(account.benefitStatus || "-");
  return `${username} (${status})`;
}

function accountListKeyboard(source, accounts) {
  const rows = accounts.slice(0, 30).map((account) => [
    Markup.button.callback(shortAccountLabel(account), `admin_open_acc:${source}:${account.id}`)
  ]);

  rows.push([Markup.button.callback("Kembali", "admin_btn_list_accounts")]);
  return Markup.inlineKeyboard(rows);
}

function accountDetailKeyboard(accountId, source) {
  const rows = [
    [
      Markup.button.callback("Set Awaiting", `admin_set_acc_status:${accountId}:AWAITING`),
      Markup.button.callback("Set Ready", `admin_set_acc_status:${accountId}:READY`)
    ],
    [Markup.button.callback("Set Applied", `admin_set_acc_status:${accountId}:APPLIED`)]
  ];

  if (source !== "sold") {
    rows.push([Markup.button.callback("Set Terjual", `admin_mark_sold:${accountId}`)]);
  }

  rows.push([
    Markup.button.callback(
      "Kembali ke List",
      source === "awaiting" ? "admin_list_src_awaiting" : "admin_list_src_ready"
    )
  ]);
  rows.push([Markup.button.callback("Kembali ke Admin Menu", "menu_admin")]);

  return Markup.inlineKeyboard(rows);
}

function renderAccountDetail(account, source) {
  const lines = [
    `ID: ${account.id}`,
    `Source: ${source}`,
    `Status: ${account.benefitStatus}`,
    `Username: ${account.username}`,
    `Password: ${account.password}`,
    `F2A: ${account.f2a}`,
    "",
    "Recovery Codes:"
  ];

  for (const code of account.recoveryCodes || []) {
    lines.push(code);
  }

  lines.push("", `Inserted: ${account.insertedAt || "-"}`, `Benefit updated: ${account.benefitUpdatedAt || "-"}`);
  return lines.join("\n");
}

function adminInputKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Batal", "admin_input_cancel")],
    [Markup.button.callback("Kembali ke Admin Menu", "menu_admin")]
  ]);
}

function setAdminState(userId, state) {
  adminInputState.set(String(userId), state);
}

function clearAdminState(userId) {
  adminInputState.delete(String(userId));
}

function getAdminState(userId) {
  return adminInputState.get(String(userId)) || null;
}

function parseSingleAccountText(rawText) {
  const lines = String(rawText || "")
    .split(/\r?\n/)
    .map((line) => line.trim());

  const username = lines.find((line) => line.toLowerCase().startsWith("username:"));
  const password = lines.find((line) => line.toLowerCase().startsWith("password:"));
  const f2a = lines.find((line) => line.toLowerCase().startsWith("f2a:"));

  if (!username || !password || !f2a) {
    return null;
  }

  const recoveryIndex = lines.findIndex((line) => line.toLowerCase() === "recovery codes:");
  const recoveryCodes = [];
  if (recoveryIndex !== -1) {
    for (let i = recoveryIndex + 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line) {
        break;
      }
      if (line.includes(":")) {
        break;
      }
      recoveryCodes.push(line);
    }
  }

  return {
    username: username.split(":").slice(1).join(":").trim(),
    password: password.split(":").slice(1).join(":").trim(),
    f2a: f2a.split(":").slice(1).join(":").trim(),
    recoveryCodes,
    seller: config.storeName
  };
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

  bot.on("text", async (ctx, next) => {
    const rawText = String(ctx.message?.text || "").trim();
    if (!rawText || rawText.startsWith("/")) {
      if (typeof next === "function") {
        return next();
      }
      return;
    }

    if (!isAdminUser(ctx)) {
      if (typeof next === "function") {
        return next();
      }
      return;
    }

    const state = getAdminState(ctx.from.id);
    if (!state) {
      if (typeof next === "function") {
        return next();
      }
      return;
    }

    if (state === "ADMIN_WAIT_SEARCH") {
      const results = findByUsername(rawText);
      clearAdminState(ctx.from.id);

      if (results.length === 0) {
        await ctx.reply("Akun tidak ditemukan.", adminMenuKeyboard());
        return;
      }

      const formatted = results
        .slice(0, 30)
        .map((item) => `- ${item.account.username} [${item.source}]`);
      await ctx.reply([`Ditemukan ${results.length} akun:`, ...formatted].join("\n"), adminMenuKeyboard());
      return;
    }

    if (state === "ADMIN_WAIT_ADD_ACCOUNT") {
      const parsed = parseSingleAccountText(rawText);
      clearAdminState(ctx.from.id);

      if (!parsed) {
        await ctx.reply(
          "Format akun tidak valid. Pastikan ada Username, Password, F2A, dan format sesuai template.",
          adminMenuKeyboard()
        );
        return;
      }

      const saved = addReadyAccount(parsed);
      await ctx.reply(`Akun ${saved.username} berhasil ditambahkan ke ready stock.`, adminMenuKeyboard());
      return;
    }

    if (state === "ADMIN_WAIT_SET_STATUS") {
      const [username, statusText] = rawText.split(/\s+/);
      clearAdminState(ctx.from.id);

      const statusMap = {
        awaiting: BENEFIT_STATUS.AWAITING,
        ready: BENEFIT_STATUS.READY,
        applied: BENEFIT_STATUS.APPLIED
      };

      const nextStatus = statusMap[String(statusText || "").toLowerCase()];
      if (!username || !nextStatus) {
        await ctx.reply(
          "Format salah. Gunakan: <username> <awaiting|ready|applied>",
          adminMenuKeyboard()
        );
        return;
      }

      const updated = upsertBenefitStatusByUsername(username, nextStatus);
      if (!updated.ok) {
        await ctx.reply("Akun tidak ditemukan atau status tidak valid.", adminMenuKeyboard());
        return;
      }

      await ctx.reply(
        [
          `Akun ${updated.account.username} berhasil diupdate.`,
          `Status benefit: ${updated.account.benefitStatus}`,
          `Pindah dari: ${updated.previousSource}`,
          `Menjadi: ${updated.nextSource}`
        ].join("\n"),
        adminMenuKeyboard()
      );
      return;
    }

    if (state === "ADMIN_WAIT_PARSE_BENEFIT") {
      clearAdminState(ctx.from.id);
      const username = rawText.split(/\s+/)[0];
      const parsedStatus = detectBenefitStatusFromSnapshotFile();

      if (!username) {
        await ctx.reply("Username wajib diisi.", adminMenuKeyboard());
        return;
      }

      if (!parsedStatus) {
        await ctx.reply("Status tidak terdeteksi dari benefit.html", adminMenuKeyboard());
        return;
      }

      const updated = upsertBenefitStatusByUsername(username, parsedStatus);
      if (!updated.ok) {
        await ctx.reply("Akun tidak ditemukan untuk username tersebut.", adminMenuKeyboard());
        return;
      }

      await ctx.reply(
        [
          `Snapshot benefit berhasil diproses untuk ${updated.account.username}.`,
          `Status baru: ${updated.account.benefitStatus}`,
          "Source data: benefit.html"
        ].join("\n"),
        adminMenuKeyboard()
      );
    }
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

    clearAdminState(ctx.from.id);
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

  bot.action("admin_input_cancel", async (ctx) => {
    if (!isAdminUser(ctx)) {
      await ctx.answerCbQuery("Anda bukan admin", { show_alert: true });
      return;
    }

    clearAdminState(ctx.from.id);
    await ctx.answerCbQuery("Input dibatalkan");
    await replyOrEdit(ctx, "Input admin dibatalkan.", adminMenuKeyboard());
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

  bot.action("admin_btn_list_accounts", async (ctx) => {
    if (!isAdminUser(ctx)) {
      await ctx.answerCbQuery("Anda bukan admin", { show_alert: true });
      return;
    }

    await ctx.answerCbQuery();
    await replyOrEdit(
      ctx,
      "Daftar akun admin. Pilih source akun:",
      accountListSourceKeyboard()
    );
  });

  bot.action("admin_list_src_awaiting", async (ctx) => {
    if (!isAdminUser(ctx)) {
      await ctx.answerCbQuery("Anda bukan admin", { show_alert: true });
      return;
    }

    await ctx.answerCbQuery();
    const accounts = getAwaitingAccounts();
    if (accounts.length === 0) {
      await replyOrEdit(ctx, "Tidak ada akun di source awaiting.", accountListSourceKeyboard());
      return;
    }

    await replyOrEdit(
      ctx,
      `List akun awaiting (${accounts.length} akun, tampil maks 30):`,
      accountListKeyboard("awaiting", accounts)
    );
  });

  bot.action("admin_list_src_ready", async (ctx) => {
    if (!isAdminUser(ctx)) {
      await ctx.answerCbQuery("Anda bukan admin", { show_alert: true });
      return;
    }

    await ctx.answerCbQuery();
    const accounts = getReadyAccounts();
    if (accounts.length === 0) {
      await replyOrEdit(ctx, "Tidak ada akun di source ready.", accountListSourceKeyboard());
      return;
    }

    await replyOrEdit(
      ctx,
      `List akun ready (${accounts.length} akun, tampil maks 30):`,
      accountListKeyboard("ready", accounts)
    );
  });

  bot.action(/^admin_open_acc:(awaiting|ready):(.+)$/, async (ctx) => {
    if (!isAdminUser(ctx)) {
      await ctx.answerCbQuery("Anda bukan admin", { show_alert: true });
      return;
    }

    const source = ctx.match[1];
    const accountId = ctx.match[2];
    const found = getAccountById(accountId);

    await ctx.answerCbQuery();
    if (!found) {
      await replyOrEdit(ctx, "Akun tidak ditemukan.", accountListSourceKeyboard());
      return;
    }

    await replyOrEdit(
      ctx,
      renderAccountDetail(found.account, source),
      accountDetailKeyboard(accountId, source)
    );
  });

  bot.action(/^admin_set_acc_status:(.+):(AWAITING|READY|APPLIED)$/, async (ctx) => {
    if (!isAdminUser(ctx)) {
      await ctx.answerCbQuery("Anda bukan admin", { show_alert: true });
      return;
    }

    const accountId = ctx.match[1];
    const status = ctx.match[2];
    const updated = upsertBenefitStatusById(accountId, status);
    await ctx.answerCbQuery();

    if (!updated.ok) {
      await replyOrEdit(ctx, "Gagal ubah status akun. Akun tidak ditemukan atau status tidak valid.", adminMenuKeyboard());
      return;
    }

    await replyOrEdit(
      ctx,
      [
        `Status akun berhasil diubah.`,
        `Username: ${updated.account.username}`,
        `Status benefit: ${updated.account.benefitStatus}`,
        `Pindah dari: ${updated.previousSource}`,
        `Menjadi: ${updated.nextSource}`
      ].join("\n"),
      adminMenuKeyboard()
    );
  });

  bot.action(/^admin_mark_sold:(.+)$/, async (ctx) => {
    if (!isAdminUser(ctx)) {
      await ctx.answerCbQuery("Anda bukan admin", { show_alert: true });
      return;
    }

    const accountId = ctx.match[1];
    const moved = moveAccountToSoldById(accountId, {
      telegramId: ctx.from?.id || null,
      orderId: `ADMIN-MARK-${Date.now()}`,
      pricePerAccount: config.productPriceIdr
    });

    await ctx.answerCbQuery();

    if (!moved.ok) {
      await replyOrEdit(ctx, "Gagal set akun menjadi terjual. Akun tidak ditemukan.", adminMenuKeyboard());
      return;
    }

    if (moved.alreadySold) {
      await replyOrEdit(
        ctx,
        `Akun ${moved.account.username} sudah berada pada status terjual.`,
        adminMenuKeyboard()
      );
      return;
    }

    await replyOrEdit(
      ctx,
      [
        "Status akun berhasil diubah.",
        `Username: ${moved.account.username}`,
        `Pindah dari: ${moved.previousSource}`,
        "Menjadi: sold"
      ].join("\n"),
      adminMenuKeyboard()
    );
  });

  bot.action("admin_btn_bulk_check_awaiting", async (ctx) => {
    if (!isAdminUser(ctx)) {
      await ctx.answerCbQuery("Anda bukan admin", { show_alert: true });
      return;
    }

    await ctx.answerCbQuery();
    const awaiting = getAwaitingAccounts();
    if (awaiting.length === 0) {
      await replyOrEdit(ctx, "Tidak ada akun awaiting untuk dicek bulk.", adminMenuKeyboard());
      return;
    }

    const parsedStatus = detectBenefitStatusFromSnapshotFile();
    if (!parsedStatus) {
      await replyOrEdit(
        ctx,
        [
          "Status tidak terdeteksi dari benefit.html.",
          "Pastikan snapshot halaman benefit sudah terbaru."
        ].join("\n"),
        adminMenuKeyboard()
      );
      return;
    }

    if (parsedStatus === BENEFIT_STATUS.AWAITING) {
      await replyOrEdit(
        ctx,
        [
          `Bulk check selesai.`,
          `Snapshot menunjukkan status: ${parsedStatus}`,
          `Tidak ada akun yang dipindahkan.`
        ].join("\n"),
        adminMenuKeyboard()
      );
      return;
    }

    let moved = 0;
    for (const account of awaiting) {
      const result = upsertBenefitStatusById(account.id, parsedStatus);
      if (result.ok) {
        moved += 1;
      }
    }

    const summary = getStockSummary();
    await replyOrEdit(
      ctx,
      [
        `Bulk check selesai.`,
        `Snapshot status: ${parsedStatus}`,
        `Akun dipindahkan dari awaiting: ${moved}`,
        `Sisa awaiting: ${summary.awaitingCount}`,
        `Ready: ${summary.readyCount}`
      ].join("\n"),
      adminMenuKeyboard()
    );
  });

  bot.action("admin_btn_cari", async (ctx) => {
    if (!isAdminUser(ctx)) {
      await ctx.answerCbQuery("Anda bukan admin", { show_alert: true });
      return;
    }

    setAdminState(ctx.from.id, "ADMIN_WAIT_SEARCH");
    await ctx.answerCbQuery();
    await replyOrEdit(
      ctx,
      "Kirim username/keyword akun yang ingin dicari.",
      adminInputKeyboard()
    );
  });

  bot.action("admin_btn_tambah", async (ctx) => {
    if (!isAdminUser(ctx)) {
      await ctx.answerCbQuery("Anda bukan admin", { show_alert: true });
      return;
    }

    setAdminState(ctx.from.id, "ADMIN_WAIT_ADD_ACCOUNT");
    await ctx.answerCbQuery();
    await replyOrEdit(
      ctx,
      [
        "Kirim blok akun dengan format:",
        "Username: ...",
        "Password: ...",
        "F2A: ...",
        "Recovery Codes:",
        "code1",
        "code2"
      ].join("\n"),
      adminInputKeyboard()
    );
  });

  bot.action("admin_btn_set_status", async (ctx) => {
    if (!isAdminUser(ctx)) {
      await ctx.answerCbQuery("Anda bukan admin", { show_alert: true });
      return;
    }

    setAdminState(ctx.from.id, "ADMIN_WAIT_SET_STATUS");
    await ctx.answerCbQuery();
    await replyOrEdit(
      ctx,
      "Kirim format: <username> <awaiting|ready|applied>",
      adminInputKeyboard()
    );
  });

  bot.action("admin_btn_parse_benefit", async (ctx) => {
    if (!isAdminUser(ctx)) {
      await ctx.answerCbQuery("Anda bukan admin", { show_alert: true });
      return;
    }

    setAdminState(ctx.from.id, "ADMIN_WAIT_PARSE_BENEFIT");
    await ctx.answerCbQuery();
    await replyOrEdit(
      ctx,
      "Kirim username akun untuk di-update berdasarkan snapshot benefit.html.",
      adminInputKeyboard()
    );
  });
}

module.exports = {
  registerUserHandlers
};
