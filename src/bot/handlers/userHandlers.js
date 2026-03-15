const { Markup } = require("telegraf");
const { config } = require("../../config/env");
const {
  getStockSummary,
  getReadyAccounts,
  addReadyAccount,
  findByUsername,
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
const ADMIN_MODE = {
  WAIT_SEARCH: "ADMIN_WAIT_SEARCH",
  WAIT_SET_STATUS: "ADMIN_WAIT_SET_STATUS",
  WAIT_PARSE_BENEFIT: "ADMIN_WAIT_PARSE_BENEFIT",
  ADD_ACCOUNT_WIZARD: "ADMIN_ADD_ACCOUNT_WIZARD"
};

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
    [Markup.button.callback("Cari Akun", "admin_btn_cari")],
    [Markup.button.callback("Tambah Akun", "admin_btn_tambah")],
    [Markup.button.callback("Set Status", "admin_btn_set_status")],
    [Markup.button.callback("Parse Benefit", "admin_btn_parse_benefit")],
    [Markup.button.callback("Kembali", "menu_back")]
  ]);
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

function isAddAccountWizardState(state) {
  return state && typeof state === "object" && state.mode === ADMIN_MODE.ADD_ACCOUNT_WIZARD;
}

function buildAddWizardPrompt(step, draft) {
  if (step === "username") {
    return "Wizard tambah akun (1/4): kirim USERNAME akun.";
  }

  if (step === "password") {
    return [
      "Wizard tambah akun (2/4): kirim PASSWORD akun.",
      `Username: ${draft.username}`
    ].join("\n");
  }

  if (step === "f2a") {
    return [
      "Wizard tambah akun (3/4): kirim F2A secret akun.",
      `Username: ${draft.username}`
    ].join("\n");
  }

  return [
    "Wizard tambah akun (4/4): kirim Recovery Codes.",
    "Kirim bisa lebih dari satu baris sekaligus.",
    "Ketik /done untuk selesai, atau /skip untuk lewati recovery codes.",
    `Username: ${draft.username}`,
    `Recovery terkumpul: ${(draft.recoveryCodes || []).length}`
  ].join("\n");
}

function parseRecoveryCodesInput(rawText) {
  return String(rawText || "")
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => !item.startsWith("/"));
}

function finalizeAddAccountWizard(ctx, draft) {
  const payload = {
    username: draft.username,
    password: draft.password,
    f2a: draft.f2a,
    recoveryCodes: Array.isArray(draft.recoveryCodes) ? draft.recoveryCodes : [],
    seller: config.storeName
  };

  const saved = addReadyAccount(payload);
  clearAdminState(ctx.from.id);
  return saved;
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
    const state = getAdminState(ctx.from.id);

    if (!rawText) {
      if (typeof next === "function") {
        return next();
      }
      return;
    }

    const isWizardCmd = rawText === "/done" || rawText === "/skip";
    if (rawText.startsWith("/") && !isWizardCmd) {
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

    if (!state) {
      if (typeof next === "function") {
        return next();
      }
      return;
    }

    if (state === ADMIN_MODE.WAIT_SEARCH) {
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

    if (isAddAccountWizardState(state)) {
      const { step, draft } = state;

      if (step === "username") {
        if (rawText.includes(" ")) {
          await ctx.reply("Username tidak boleh mengandung spasi. Coba lagi.", adminInputKeyboard());
          return;
        }

        setAdminState(ctx.from.id, {
          mode: ADMIN_MODE.ADD_ACCOUNT_WIZARD,
          step: "password",
          draft: {
            ...draft,
            username: rawText
          }
        });

        await ctx.reply(buildAddWizardPrompt("password", { ...draft, username: rawText }), adminInputKeyboard());
        return;
      }

      if (step === "password") {
        setAdminState(ctx.from.id, {
          mode: ADMIN_MODE.ADD_ACCOUNT_WIZARD,
          step: "f2a",
          draft: {
            ...draft,
            password: rawText
          }
        });

        await ctx.reply(buildAddWizardPrompt("f2a", { ...draft, password: rawText }), adminInputKeyboard());
        return;
      }

      if (step === "f2a") {
        const nextDraft = {
          ...draft,
          f2a: rawText,
          recoveryCodes: Array.isArray(draft.recoveryCodes) ? draft.recoveryCodes : []
        };

        setAdminState(ctx.from.id, {
          mode: ADMIN_MODE.ADD_ACCOUNT_WIZARD,
          step: "recovery",
          draft: nextDraft
        });

        await ctx.reply(buildAddWizardPrompt("recovery", nextDraft), adminInputKeyboard());
        return;
      }

      if (step === "recovery") {
        if (rawText === "/skip") {
          const saved = finalizeAddAccountWizard(ctx, { ...draft, recoveryCodes: [] });
          await ctx.reply(`Akun ${saved.username} berhasil ditambahkan ke ready stock.`, adminMenuKeyboard());
          return;
        }

        if (rawText === "/done") {
          const saved = finalizeAddAccountWizard(ctx, draft);
          await ctx.reply(
            `Akun ${saved.username} berhasil ditambahkan ke ready stock. Recovery codes: ${(saved.recoveryCodes || []).length}`,
            adminMenuKeyboard()
          );
          return;
        }

        const incoming = parseRecoveryCodesInput(rawText);
        if (incoming.length === 0) {
          await ctx.reply("Recovery codes kosong. Kirim kode valid atau ketik /done untuk selesai.", adminInputKeyboard());
          return;
        }

        const merged = Array.from(new Set([...(draft.recoveryCodes || []), ...incoming]));
        const nextDraft = { ...draft, recoveryCodes: merged };

        setAdminState(ctx.from.id, {
          mode: ADMIN_MODE.ADD_ACCOUNT_WIZARD,
          step: "recovery",
          draft: nextDraft
        });

        await ctx.reply(
          `Recovery codes ditambahkan (${incoming.length} baru, total ${merged.length}). Ketik /done untuk selesai.`,
          adminInputKeyboard()
        );
        return;
      }
    }

    if (state === ADMIN_MODE.WAIT_SET_STATUS) {
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

    if (state === ADMIN_MODE.WAIT_PARSE_BENEFIT) {
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

  bot.action("admin_btn_cari", async (ctx) => {
    if (!isAdminUser(ctx)) {
      await ctx.answerCbQuery("Anda bukan admin", { show_alert: true });
      return;
    }

    setAdminState(ctx.from.id, ADMIN_MODE.WAIT_SEARCH);
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

    setAdminState(ctx.from.id, {
      mode: ADMIN_MODE.ADD_ACCOUNT_WIZARD,
      step: "username",
      draft: {
        recoveryCodes: []
      }
    });
    await ctx.answerCbQuery();
    await replyOrEdit(
      ctx,
      buildAddWizardPrompt("username", { recoveryCodes: [] }),
      adminInputKeyboard()
    );
  });

  bot.action("admin_btn_set_status", async (ctx) => {
    if (!isAdminUser(ctx)) {
      await ctx.answerCbQuery("Anda bukan admin", { show_alert: true });
      return;
    }

    setAdminState(ctx.from.id, ADMIN_MODE.WAIT_SET_STATUS);
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

    setAdminState(ctx.from.id, ADMIN_MODE.WAIT_PARSE_BENEFIT);
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
