const { Markup } = require("telegraf");
const { config } = require("../../config/env");
const {
  getStockSummary,
  getReadyAccounts,
  getAwaitingAccounts,
  getSoldAccounts,
  addReadyAccount,
  findByUsername,
  getAccountById,
  deleteAccountById,
  moveAccountToSoldById,
  upsertBenefitStatusById,
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

const userCheckoutQty = new Map();
const adminInputState = new Map();
const adminMassState = new Map();
const adminSearchState = new Map();
const ACCOUNT_LIST_PAGE_SIZE = 10;

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
    [Markup.button.callback("Ubah Status Akun Masal", "admin_btn_mass_status")],
    [Markup.button.callback("Cari Akun", "admin_btn_cari")],
    [Markup.button.callback("Tambah Akun", "admin_btn_tambah")],
    [Markup.button.callback("Kembali", "menu_back")]
  ]);
}

function accountListSourceKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Awaiting", "admin_list_src:awaiting:1")],
    [Markup.button.callback("Ready", "admin_list_src:ready:1")],
    [Markup.button.callback("Terjual", "admin_list_src:sold:1")],
    [Markup.button.callback("Kembali", "menu_admin")]
  ]);
}

function getAccountsBySource(source) {
  if (source === "awaiting") {
    return getAwaitingAccounts();
  }

  if (source === "sold") {
    return getSoldAccounts();
  }

  return getReadyAccounts();
}

function clampPage(page, totalItems) {
  const totalPages = Math.max(1, Math.ceil(totalItems / ACCOUNT_LIST_PAGE_SIZE));
  const current = Number(page) || 1;
  return Math.max(1, Math.min(totalPages, current));
}

function shortAccountLabel(account) {
  const username = String(account.username || "-");
  const status = String(account.benefitStatus || "-");
  return `${username} (${status})`;
}

function accountListKeyboard(source, accounts, page) {
  const currentPage = clampPage(page, accounts.length);
  const start = (currentPage - 1) * ACCOUNT_LIST_PAGE_SIZE;
  const end = start + ACCOUNT_LIST_PAGE_SIZE;
  const visible = accounts.slice(start, end);

  const rows = visible.map((account) => [
    Markup.button.callback(shortAccountLabel(account), `admin_open_acc:${source}:${account.id}:${currentPage}`)
  ]);

  const totalPages = Math.max(1, Math.ceil(accounts.length / ACCOUNT_LIST_PAGE_SIZE));

  if (totalPages > 1) {
    const navRow = [];
    if (currentPage > 1) {
      navRow.push(Markup.button.callback("Prev", `admin_list_src:${source}:${currentPage - 1}`));
    }
    navRow.push(Markup.button.callback(`${currentPage}/${totalPages}`, "admin_page_noop"));
    if (currentPage < totalPages) {
      navRow.push(Markup.button.callback("Next", `admin_list_src:${source}:${currentPage + 1}`));
    }
    rows.push(navRow);
  }

  rows.push([Markup.button.callback("Kembali", "admin_btn_list_accounts")]);
  return Markup.inlineKeyboard(rows);
}

function accountDetailKeyboard(accountId, source, page, backCallback) {
  const rows = [
    [
      Markup.button.callback("Set Awaiting", `admin_set_acc_status:${accountId}:AWAITING`),
      Markup.button.callback("Set Ready", `admin_set_acc_status:${accountId}:READY`)
    ]
  ];

  if (source !== "sold") {
    rows.push([Markup.button.callback("Set Terjual", `admin_mark_sold:${accountId}`)]);
  }

  rows.push([Markup.button.callback("Hapus", `admin_delete_acc_prompt:${accountId}:${source}:${page || 1}`)]);

  rows.push([
    Markup.button.callback(
      "Kembali ke List",
      backCallback || `admin_list_src:${source}:${page || 1}`
    )
  ]);
  rows.push([Markup.button.callback("Kembali ke Admin Menu", "menu_admin")]);

  return Markup.inlineKeyboard(rows);
}

function accountDeleteConfirmKeyboard(accountId, source, page) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("Ya, Hapus", `admin_delete_acc_confirm:${accountId}:${source}:${page || 1}`),
      Markup.button.callback("Batal", `admin_delete_acc_cancel:${accountId}:${source}:${page || 1}`)
    ],
    [Markup.button.callback("Kembali ke Admin Menu", "menu_admin")]
  ]);
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

function adminMassStatusKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Source Awaiting", "admin_mass_src:awaiting:1")],
    [Markup.button.callback("Source Ready", "admin_mass_src:ready:1")],
    [Markup.button.callback("Source Terjual", "admin_mass_src:sold:1")],
    [Markup.button.callback("Kembali", "menu_admin")]
  ]);
}

function setAdminMassState(userId, state) {
  adminMassState.set(String(userId), state);
}

function getAdminMassState(userId) {
  return adminMassState.get(String(userId)) || null;
}

function clearAdminMassState(userId) {
  adminMassState.delete(String(userId));
}

function setAdminSearchState(userId, state) {
  adminSearchState.set(String(userId), state);
}

function getAdminSearchState(userId) {
  return adminSearchState.get(String(userId)) || null;
}

function clearAdminSearchState(userId) {
  adminSearchState.delete(String(userId));
}

function searchResultKeyboard(results, page) {
  const currentPage = clampPage(page, results.length);
  const start = (currentPage - 1) * ACCOUNT_LIST_PAGE_SIZE;
  const end = start + ACCOUNT_LIST_PAGE_SIZE;
  const visible = results.slice(start, end);

  const rows = visible.map((item) => [
    Markup.button.callback(
      `${item.account.username} [${item.source}]`,
      `admin_open_search_acc:${item.source}:${item.account.id}:${currentPage}`
    )
  ]);

  const totalPages = Math.max(1, Math.ceil(results.length / ACCOUNT_LIST_PAGE_SIZE));
  if (totalPages > 1) {
    const navRow = [];
    if (currentPage > 1) {
      navRow.push(Markup.button.callback("Prev", `admin_search_page:${currentPage - 1}`));
    }
    navRow.push(Markup.button.callback(`${currentPage}/${totalPages}`, "admin_page_noop"));
    if (currentPage < totalPages) {
      navRow.push(Markup.button.callback("Next", `admin_search_page:${currentPage + 1}`));
    }
    rows.push(navRow);
  }

  rows.push([
    Markup.button.callback("Cari Lagi", "admin_btn_cari"),
    Markup.button.callback("Kembali", "menu_admin")
  ]);

  return Markup.inlineKeyboard(rows);
}

function massTargetButtons(state) {
  const targets = [
    { label: "Awaiting", value: "AWAITING" },
    { label: "Ready", value: "READY" },
    { label: "Terjual", value: "SOLD" }
  ];

  return targets.map((target) => {
    const checked = state.target === target.value ? "[x]" : "[ ]";
    return Markup.button.callback(
      `${checked} ${target.label}`,
      `admin_mass_target:${state.source}:${target.value}`
    );
  });
}

function massAccountListKeyboard(source, accounts, page, state) {
  const currentPage = clampPage(page, accounts.length);
  const start = (currentPage - 1) * ACCOUNT_LIST_PAGE_SIZE;
  const end = start + ACCOUNT_LIST_PAGE_SIZE;
  const visible = accounts.slice(start, end);

  const rows = visible.map((account) => {
    const selected = state.selectedIds.has(account.id) ? "[x]" : "[ ]";
    return [
      Markup.button.callback(
        `${selected} ${shortAccountLabel(account)}`,
        `admin_mass_toggle:${source}:${currentPage}:${account.id}`
      )
    ];
  });

  const totalPages = Math.max(1, Math.ceil(accounts.length / ACCOUNT_LIST_PAGE_SIZE));
  if (totalPages > 1) {
    const navRow = [];
    if (currentPage > 1) {
      navRow.push(Markup.button.callback("Prev", `admin_mass_src:${source}:${currentPage - 1}`));
    }
    navRow.push(Markup.button.callback(`${currentPage}/${totalPages}`, "admin_page_noop"));
    if (currentPage < totalPages) {
      navRow.push(Markup.button.callback("Next", `admin_mass_src:${source}:${currentPage + 1}`));
    }
    rows.push(navRow);
  }

  rows.push(massTargetButtons(state));
  rows.push([
    Markup.button.callback(
      state.selectedIds.size === accounts.length ? "Batalkan Pilih Semua" : "Pilih Semua",
      `admin_mass_select_all:${source}:${currentPage}`
    )
  ]);
  rows.push([
    Markup.button.callback("Terapkan ke Akun Terpilih", `admin_mass_apply:${source}:${currentPage}`)
  ]);
  rows.push([
    Markup.button.callback("Reset Pilihan", `admin_mass_reset:${source}:${currentPage}`),
    Markup.button.callback("Kembali", "admin_btn_mass_status")
  ]);

  return Markup.inlineKeyboard(rows);
}

function runMassStatusUpdateByIds(selectedIds, targetStatus) {
  const ids = Array.from(selectedIds || []);
  const target = String(targetStatus || "").toUpperCase();

  if (ids.length === 0) {
    return { ok: false, reason: "NO_SELECTED_ACCOUNT" };
  }

  let success = 0;
  let failed = 0;

  for (const accountId of ids) {
    let result;
    if (target === "SOLD") {
      result = moveAccountToSoldById(accountId, {
        orderId: `ADMIN-MASS-${Date.now()}`,
        pricePerAccount: config.productPriceIdr
      });
    } else {
      result = upsertBenefitStatusById(accountId, target);
    }

    if (result && result.ok) {
      success += 1;
    } else {
      failed += 1;
    }
  }

  return {
    ok: true,
    target,
    total: ids.length,
    success,
    failed
  };
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
      clearAdminSearchState(ctx.from.id);

      if (results.length === 0) {
        await ctx.reply("Akun tidak ditemukan.", adminMenuKeyboard());
        return;
      }

      setAdminSearchState(ctx.from.id, {
        keyword: rawText,
        results
      });

      const page = 1;
      const totalPages = Math.max(1, Math.ceil(results.length / ACCOUNT_LIST_PAGE_SIZE));
      await ctx.reply(
        `Ditemukan ${results.length} akun untuk keyword '${rawText}' - halaman ${page}/${totalPages}`,
        searchResultKeyboard(results, page)
      );
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

    if (typeof next === "function") {
      return next();
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
    clearAdminMassState(ctx.from.id);
    clearAdminSearchState(ctx.from.id);
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
    clearAdminMassState(ctx.from.id);
    clearAdminSearchState(ctx.from.id);
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

  bot.action(/^admin_list_src:(awaiting|ready|sold):(\d+)$/, async (ctx) => {
    if (!isAdminUser(ctx)) {
      await ctx.answerCbQuery("Anda bukan admin", { show_alert: true });
      return;
    }

    const source = ctx.match[1];
    const requestedPage = Number(ctx.match[2]);
    await ctx.answerCbQuery();
    const accounts = getAccountsBySource(source);
    if (accounts.length === 0) {
      await replyOrEdit(ctx, `Tidak ada akun di source ${source}.`, accountListSourceKeyboard());
      return;
    }

    const page = clampPage(requestedPage, accounts.length);
    const totalPages = Math.max(1, Math.ceil(accounts.length / ACCOUNT_LIST_PAGE_SIZE));

    await replyOrEdit(
      ctx,
      `List akun ${source} (${accounts.length} akun) - halaman ${page}/${totalPages}`,
      accountListKeyboard(source, accounts, page)
    );
  });

  bot.action(/^admin_open_acc:(awaiting|ready|sold):(.+):(\d+)$/, async (ctx) => {
    if (!isAdminUser(ctx)) {
      await ctx.answerCbQuery("Anda bukan admin", { show_alert: true });
      return;
    }

    const source = ctx.match[1];
    const accountId = ctx.match[2];
    const page = Number(ctx.match[3]) || 1;
    const found = getAccountById(accountId);

    await ctx.answerCbQuery();
    if (!found) {
      await replyOrEdit(ctx, "Akun tidak ditemukan.", accountListSourceKeyboard());
      return;
    }

    await replyOrEdit(
      ctx,
      renderAccountDetail(found.account, source),
      accountDetailKeyboard(accountId, source, page)
    );
  });

  bot.action(/^admin_search_page:(\d+)$/, async (ctx) => {
    if (!isAdminUser(ctx)) {
      await ctx.answerCbQuery("Anda bukan admin", { show_alert: true });
      return;
    }

    const requestedPage = Number(ctx.match[1]);
    const state = getAdminSearchState(ctx.from.id);
    if (!state || !Array.isArray(state.results) || state.results.length === 0) {
      await ctx.answerCbQuery("Data pencarian tidak ada", { show_alert: true });
      return;
    }

    const page = clampPage(requestedPage, state.results.length);
    const totalPages = Math.max(1, Math.ceil(state.results.length / ACCOUNT_LIST_PAGE_SIZE));
    await ctx.answerCbQuery();
    await replyOrEdit(
      ctx,
      `Ditemukan ${state.results.length} akun untuk keyword '${state.keyword}' - halaman ${page}/${totalPages}`,
      searchResultKeyboard(state.results, page)
    );
  });

  bot.action(/^admin_open_search_acc:(awaiting|ready|sold):(.+):(\d+)$/, async (ctx) => {
    if (!isAdminUser(ctx)) {
      await ctx.answerCbQuery("Anda bukan admin", { show_alert: true });
      return;
    }

    const source = ctx.match[1];
    const accountId = ctx.match[2];
    const page = Number(ctx.match[3]) || 1;
    const found = getAccountById(accountId);

    await ctx.answerCbQuery();
    if (!found) {
      await replyOrEdit(ctx, "Akun tidak ditemukan.", adminMenuKeyboard());
      return;
    }

    await replyOrEdit(
      ctx,
      renderAccountDetail(found.account, source),
      accountDetailKeyboard(accountId, source, page, `admin_search_page:${page}`)
    );
  });

  bot.action(/^admin_set_acc_status:(.+):(AWAITING|READY)$/, async (ctx) => {
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

  bot.action(/^admin_delete_acc:(.+)$/, async (ctx) => {
    // Backward compatibility for old callback payloads.
    if (!isAdminUser(ctx)) {
      await ctx.answerCbQuery("Anda bukan admin", { show_alert: true });
      return;
    }

    const accountId = ctx.match[1];
    const removed = deleteAccountById(accountId);
    await ctx.answerCbQuery();

    if (!removed.ok) {
      await replyOrEdit(ctx, "Gagal hapus akun. Akun tidak ditemukan.", adminMenuKeyboard());
      return;
    }

    await replyOrEdit(
      ctx,
      [
        "Akun berhasil dihapus.",
        `Username: ${removed.account.username}`,
        `Source asal: ${removed.source}`,
        `ID: ${removed.account.id}`
      ].join("\n"),
      adminMenuKeyboard()
    );
  });

  bot.action(/^admin_delete_acc_prompt:([^:]+):(awaiting|ready|sold):(\d+)$/, async (ctx) => {
    if (!isAdminUser(ctx)) {
      await ctx.answerCbQuery("Anda bukan admin", { show_alert: true });
      return;
    }

    const accountId = ctx.match[1];
    const source = ctx.match[2];
    const page = Number(ctx.match[3]) || 1;
    const found = getAccountById(accountId);

    await ctx.answerCbQuery();
    if (!found) {
      await replyOrEdit(ctx, "Akun tidak ditemukan.", adminMenuKeyboard());
      return;
    }

    await replyOrEdit(
      ctx,
      [
        "Konfirmasi Hapus Akun",
        `Username: ${found.account.username}`,
        `ID: ${found.account.id}`,
        "Tindakan ini akan menghapus akun secara permanen dari data source."
      ].join("\n"),
      accountDeleteConfirmKeyboard(accountId, source, page)
    );
  });

  bot.action(/^admin_delete_acc_cancel:([^:]+):(awaiting|ready|sold):(\d+)$/, async (ctx) => {
    if (!isAdminUser(ctx)) {
      await ctx.answerCbQuery("Anda bukan admin", { show_alert: true });
      return;
    }

    const accountId = ctx.match[1];
    const source = ctx.match[2];
    const page = Number(ctx.match[3]) || 1;
    const found = getAccountById(accountId);

    await ctx.answerCbQuery("Hapus dibatalkan");
    if (!found) {
      await replyOrEdit(ctx, "Akun tidak ditemukan.", adminMenuKeyboard());
      return;
    }

    await replyOrEdit(
      ctx,
      renderAccountDetail(found.account, source),
      accountDetailKeyboard(accountId, source, page)
    );
  });

  bot.action(/^admin_delete_acc_confirm:([^:]+):(awaiting|ready|sold):(\d+)$/, async (ctx) => {
    if (!isAdminUser(ctx)) {
      await ctx.answerCbQuery("Anda bukan admin", { show_alert: true });
      return;
    }

    const accountId = ctx.match[1];
    await ctx.answerCbQuery();

    const removed = deleteAccountById(accountId);
    if (!removed.ok) {
      await replyOrEdit(ctx, "Gagal hapus akun. Akun tidak ditemukan.", adminMenuKeyboard());
      return;
    }

    await replyOrEdit(
      ctx,
      [
        "Akun berhasil dihapus.",
        `Username: ${removed.account.username}`,
        `Source asal: ${removed.source}`,
        `ID: ${removed.account.id}`
      ].join("\n"),
      adminMenuKeyboard()
    );
  });

  bot.action("admin_btn_mass_status", async (ctx) => {
    if (!isAdminUser(ctx)) {
      await ctx.answerCbQuery("Anda bukan admin", { show_alert: true });
      return;
    }

    await ctx.answerCbQuery();
    clearAdminMassState(ctx.from.id);
    await replyOrEdit(
      ctx,
      "Pilih source akun untuk ubah status massal (pilih akun tertentu):",
      adminMassStatusKeyboard()
    );
  });

  bot.action(/^admin_mass_src:(awaiting|ready|sold):(\d+)$/, async (ctx) => {
    if (!isAdminUser(ctx)) {
      await ctx.answerCbQuery("Anda bukan admin", { show_alert: true });
      return;
    }

    const source = ctx.match[1];
    const requestedPage = Number(ctx.match[2]);
    const accounts = getAccountsBySource(source);
    const currentPage = clampPage(requestedPage, accounts.length);

    let state = getAdminMassState(ctx.from.id);
    if (!state || state.source !== source) {
      state = {
        source,
        selectedIds: new Set(),
        target: "READY"
      };
      setAdminMassState(ctx.from.id, state);
    }

    await ctx.answerCbQuery();
    await replyOrEdit(
      ctx,
      [
        `Ubah Status Akun Masal`,
        `Source: ${source}`,
        `Dipilih: ${state.selectedIds.size} akun`,
        `Target: ${state.target}`,
        `Total source: ${accounts.length}`
      ].join("\n"),
      massAccountListKeyboard(source, accounts, currentPage, state)
    );
  });

  bot.action(/^admin_mass_toggle:(awaiting|ready|sold):(\d+):(.+)$/, async (ctx) => {
    if (!isAdminUser(ctx)) {
      await ctx.answerCbQuery("Anda bukan admin", { show_alert: true });
      return;
    }

    const source = ctx.match[1];
    const page = Number(ctx.match[2]);
    const accountId = ctx.match[3];
    const state = getAdminMassState(ctx.from.id);

    if (!state || state.source !== source) {
      await ctx.answerCbQuery("Pilih source mass status dulu", { show_alert: true });
      return;
    }

    if (state.selectedIds.has(accountId)) {
      state.selectedIds.delete(accountId);
    } else {
      state.selectedIds.add(accountId);
    }

    setAdminMassState(ctx.from.id, state);
    await ctx.answerCbQuery();

    const accounts = getAccountsBySource(source);
    await replyOrEdit(
      ctx,
      [
        `Ubah Status Akun Masal`,
        `Source: ${source}`,
        `Dipilih: ${state.selectedIds.size} akun`,
        `Target: ${state.target}`,
        `Total source: ${accounts.length}`
      ].join("\n"),
      massAccountListKeyboard(source, accounts, page, state)
    );
  });

  bot.action(/^admin_mass_target:(awaiting|ready|sold):(AWAITING|READY|SOLD)$/, async (ctx) => {
    if (!isAdminUser(ctx)) {
      await ctx.answerCbQuery("Anda bukan admin", { show_alert: true });
      return;
    }

    const source = ctx.match[1];
    const target = ctx.match[2];
    const state = getAdminMassState(ctx.from.id);

    if (!state || state.source !== source) {
      await ctx.answerCbQuery("Pilih source mass status dulu", { show_alert: true });
      return;
    }

    state.target = target;
    setAdminMassState(ctx.from.id, state);
    await ctx.answerCbQuery(`Target set ke ${target}`);

    const accounts = getAccountsBySource(source);
    await replyOrEdit(
      ctx,
      [
        `Ubah Status Akun Masal`,
        `Source: ${source}`,
        `Dipilih: ${state.selectedIds.size} akun`,
        `Target: ${state.target}`,
        `Total source: ${accounts.length}`
      ].join("\n"),
      massAccountListKeyboard(source, accounts, 1, state)
    );
  });

  bot.action(/^admin_mass_reset:(awaiting|ready|sold):(\d+)$/, async (ctx) => {
    if (!isAdminUser(ctx)) {
      await ctx.answerCbQuery("Anda bukan admin", { show_alert: true });
      return;
    }

    const source = ctx.match[1];
    const page = Number(ctx.match[2]);
    const state = getAdminMassState(ctx.from.id);

    if (!state || state.source !== source) {
      await ctx.answerCbQuery("Pilih source mass status dulu", { show_alert: true });
      return;
    }

    state.selectedIds = new Set();
    setAdminMassState(ctx.from.id, state);
    await ctx.answerCbQuery("Pilihan akun direset");

    const accounts = getAccountsBySource(source);
    await replyOrEdit(
      ctx,
      [
        `Ubah Status Akun Masal`,
        `Source: ${source}`,
        `Dipilih: ${state.selectedIds.size} akun`,
        `Target: ${state.target}`,
        `Total source: ${accounts.length}`
      ].join("\n"),
      massAccountListKeyboard(source, accounts, page, state)
    );
  });

  bot.action(/^admin_mass_select_all:(awaiting|ready|sold):(\d+)$/, async (ctx) => {
    if (!isAdminUser(ctx)) {
      await ctx.answerCbQuery("Anda bukan admin", { show_alert: true });
      return;
    }

    const source = ctx.match[1];
    const page = Number(ctx.match[2]);
    const state = getAdminMassState(ctx.from.id);

    if (!state || state.source !== source) {
      await ctx.answerCbQuery("Pilih source mass status dulu", { show_alert: true });
      return;
    }

    const accounts = getAccountsBySource(source);
    if (state.selectedIds.size === accounts.length) {
      state.selectedIds = new Set();
      await ctx.answerCbQuery("Semua pilihan dibatalkan");
    } else {
      state.selectedIds = new Set(accounts.map((acc) => acc.id));
      await ctx.answerCbQuery(`Semua akun ${source} dipilih`);
    }

    setAdminMassState(ctx.from.id, state);
    await replyOrEdit(
      ctx,
      [
        `Ubah Status Akun Masal`,
        `Source: ${source}`,
        `Dipilih: ${state.selectedIds.size} akun`,
        `Target: ${state.target}`,
        `Total source: ${accounts.length}`
      ].join("\n"),
      massAccountListKeyboard(source, accounts, page, state)
    );
  });

  bot.action(/^admin_mass_apply:(awaiting|ready|sold):(\d+)$/, async (ctx) => {
    if (!isAdminUser(ctx)) {
      await ctx.answerCbQuery("Anda bukan admin", { show_alert: true });
      return;
    }

    const source = ctx.match[1];
    const state = getAdminMassState(ctx.from.id);

    if (!state || state.source !== source) {
      await ctx.answerCbQuery("Pilih source mass status dulu", { show_alert: true });
      return;
    }

    const result = runMassStatusUpdateByIds(state.selectedIds, state.target);
    if (!result.ok) {
      await ctx.answerCbQuery("Belum ada akun terpilih", { show_alert: true });
      return;
    }

    await ctx.answerCbQuery();
    clearAdminMassState(ctx.from.id);

    const summary = getStockSummary();
    await replyOrEdit(
      ctx,
      [
        "Ubah status masal selesai.",
        `Source: ${source}`,
        `Target: ${result.target}`,
        `Diproses: ${result.total}`,
        `Berhasil: ${result.success}`,
        `Gagal: ${result.failed}`,
        "",
        `Ready: ${summary.readyCount}`,
        `Awaiting: ${summary.awaitingCount}`,
        `Sold: ${summary.soldCount}`
      ].join("\n"),
      adminMenuKeyboard()
    );
  });

  bot.action("admin_page_noop", async (ctx) => {
    await ctx.answerCbQuery("Gunakan Prev/Next untuk pindah halaman");
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

}

module.exports = {
  registerUserHandlers
};
