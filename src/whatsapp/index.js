const qrcode = require("qrcode-terminal");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const { config } = require("../config/env");
const { formatCurrencyIdr, formatTimestampWib } = require("../utils/formatters");
const {
  getStockSummary,
  getReadyAccounts,
  addReadyAccount,
  findByUsername,
  upsertBenefitStatusByUsername,
  BENEFIT_STATUS
} = require("../services/accountService");
const {
  createOrder,
  getOrderById,
  markOrderPaid,
  getPendingOrders,
  getRevenueSummary,
  resetRevenueSummary
} = require("../services/orderService");
const { deliverOrderAccounts } = require("../services/deliveryService");
const { checkAndNotifyReadyStock, notifyOrderCreated } = require("../services/adminNotificationService");
const { getBroadcastAudience, touchCustomer } = require("../services/customerService");
const { startDailyStatusCheck } = require("../services/schedulerService");
const { startPaymentWebhookServer } = require("../services/paymentWebhookServer");

if (!config.whatsappEnabled) {
  throw new Error("WHATSAPP_ENABLED harus true untuk menjalankan bot WhatsApp.");
}

function normalizePhone(raw) {
  return String(raw || "").replace(/\D/g, "");
}

function toWhatsappChatId(value) {
  const text = String(value || "");
  if (text.includes("@")) {
    return text;
  }

  const phone = normalizePhone(text);
  return phone ? `${phone}@c.us` : text;
}

function getSenderPhone(message) {
  const from = String(message.from || "");
  const [phone] = from.split("@");
  return normalizePhone(phone);
}

function isAdminMessage(message) {
  const phone = getSenderPhone(message);
  return config.adminWhatsappNumbers.includes(phone);
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

function renderMainMenu(isAdmin) {
  const stock = getStockSummary();
  const lines = [
    `Selamat datang di ${config.storeName}.`,
    `Produk: ${config.productName}`,
    `Harga per akun: ${formatCurrencyIdr(config.productPriceIdr)}`,
    `Stok ready: ${stock.readyCount}`,
    `Awaiting: ${stock.awaitingCount}`,
    "",
    "Perintah user:",
    "/produk",
    "/checkout <qty>",
    "/status <order_id>",
    "/paid <order_id> (simulasi)",
    "/myid"
  ];

  if (isAdmin) {
    lines.push(
      "",
      "Perintah admin:",
      "/admin",
      "/admin_stok",
      "/admin_pending",
      "/admin_pendapatan",
      "/admin_reset_pendapatan",
      "/admin_cari <username>",
      "/admin_tambah <blok akun>",
      "/admin_set_status <username> <awaiting|ready>",
      "/admin_broadcast <pesan>"
    );
  }

  return lines.join("\n");
}

function renderOrderStatus(order) {
  return [
    `Order: ${order.id}`,
    `Status: ${order.status}`,
    `Total: ${formatCurrencyIdr(order.total)}`,
    `Invoice: ${order.payment.invoiceUrl}`,
    `Expired (WIB): ${formatTimestampWib(order.payment.expiresAt, config.displayTimezone)}`,
    `Paid At (WIB): ${formatTimestampWib(order.payment.paidAt, config.displayTimezone)}`,
    `Payment ref: ${order.payment.paidReference || "-"}`,
    `Delivery attempts: ${order.delivery && Number.isInteger(order.delivery.attempts) ? order.delivery.attempts : 0}`,
    `Delivery error: ${order.delivery && order.delivery.lastError ? order.delivery.lastError : "-"}`
  ].join("\n");
}

async function sendMessage(client, to, text) {
  await client.sendMessage(toWhatsappChatId(to), text);
}

async function sendDocument(client, to, file, options = {}) {
  const buffer = file && file.source ? file.source : Buffer.from("");
  const filename = file && file.filename ? file.filename : "file.txt";
  const media = new MessageMedia("text/plain", buffer.toString("base64"), filename);
  await client.sendMessage(toWhatsappChatId(to), media, { caption: options.caption || "" });
}

function buildBotAdapter(client) {
  return {
    channel: "whatsapp",
    telegram: {
      sendMessage: (chatId, text) => sendMessage(client, chatId, text),
      sendDocument: (chatId, file, options) => sendDocument(client, chatId, file, options)
    }
  };
}

async function handleUserCommand(client, botAdapter, message, command, args) {
  const senderPhone = getSenderPhone(message);
  const senderId = `wa:${senderPhone}`;

  if (command === "/start" || command === "/menu" || command === "/help") {
    await sendMessage(client, message.from, renderMainMenu(isAdminMessage(message)));
    return;
  }

  if (command === "/myid") {
    await sendMessage(client, message.from, `WhatsApp ID Anda: ${senderPhone}`);
    return;
  }

  if (command === "/produk") {
    const stock = getStockSummary();
    await sendMessage(
      client,
      message.from,
      [
        "Info Produk",
        `Produk: ${config.productName}`,
        `Harga per akun: ${formatCurrencyIdr(config.productPriceIdr)}`,
        `Stok ready: ${stock.readyCount}`,
        `Awaiting benefits: ${stock.awaitingCount}`,
        "",
        "Contoh checkout: /checkout 2"
      ].join("\n")
    );
    return;
  }

  if (command === "/checkout") {
    const qty = Number(args[0]);
    if (!Number.isInteger(qty) || qty <= 0) {
      await sendMessage(client, message.from, "Masukkan jumlah valid. Contoh: /checkout 1");
      return;
    }

    const ready = getReadyAccounts();
    if (ready.length < qty) {
      await sendMessage(client, message.from, "Stok ready tidak cukup untuk jumlah tersebut.");
      return;
    }

    const reserved = ready.slice(0, qty).map((item) => item.id);
    const order = createOrder({
      telegramId: senderId,
      quantity: qty,
      reservedAccounts: reserved
    });

    await notifyOrderCreated(botAdapter, order);

    await sendMessage(
      client,
      message.from,
      [
        "Pesanan berhasil dibuat",
        `Order ID: ${order.id}`,
        `Total: ${formatCurrencyIdr(order.total)}`,
        `Invoice QRIS: ${order.payment.invoiceUrl}`,
        `Batas Bayar (WIB): ${formatTimestampWib(order.payment.expiresAt, config.displayTimezone)}`,
        "",
        "Cek status: /status <order_id>",
        "Simulasi bayar: /paid <order_id>"
      ].join("\n")
    );
    return;
  }

  if (command === "/status") {
    const orderId = args[0];
    if (!orderId) {
      await sendMessage(client, message.from, "Gunakan: /status <order_id>");
      return;
    }

    const order = getOrderById(orderId);
    if (!order) {
      await sendMessage(client, message.from, "Order tidak ditemukan.");
      return;
    }

    if (String(order.telegramId) !== senderId) {
      await sendMessage(client, message.from, "Order ini bukan milik Anda.");
      return;
    }

    await sendMessage(client, message.from, renderOrderStatus(order));
    return;
  }

  if (command === "/paid") {
    const orderId = args[0];
    if (!orderId) {
      await sendMessage(client, message.from, "Gunakan: /paid <order_id>");
      return;
    }

    const order = getOrderById(orderId);
    if (!order) {
      await sendMessage(client, message.from, "Order tidak ditemukan.");
      return;
    }

    if (String(order.telegramId) !== senderId) {
      await sendMessage(client, message.from, "Order ini bukan milik Anda.");
      return;
    }

    const paid = markOrderPaid(order.id);
    if (!paid) {
      await sendMessage(client, message.from, "Gagal update status order.");
      return;
    }

    const delivery = await deliverOrderAccounts(botAdapter, paid);
    if (!delivery.ok) {
      await sendMessage(client, message.from, "Akun untuk order ini sudah tidak tersedia. Hubungi admin.");
    }
  }
}

async function handleAdminCommand(client, botAdapter, message, command, args, rawBody) {
  if (!isAdminMessage(message)) {
    await sendMessage(client, message.from, "Perintah admin hanya untuk nomor admin terdaftar.");
    return;
  }

  if (command === "/admin") {
    await sendMessage(client, message.from, renderMainMenu(true));
    return;
  }

  if (command === "/admin_stok") {
    const stock = getStockSummary();
    await sendMessage(
      client,
      message.from,
      [
        "Dashboard Stok",
        `Ready: ${stock.readyCount}`,
        `Awaiting: ${stock.awaitingCount}`,
        `Sold: ${stock.soldCount}`,
        `Sold (coupon applied): ${stock.appliedSoldCount}`
      ].join("\n")
    );
    return;
  }

  if (command === "/admin_pending") {
    const pending = getPendingOrders();
    if (pending.length === 0) {
      await sendMessage(client, message.from, "Tidak ada transaksi pending saat ini.");
      return;
    }

    const preview = pending.slice(0, 10).map((row) => `- ${row.id} | ${formatCurrencyIdr(row.total)}`);
    await sendMessage(
      client,
      message.from,
      [
        `Total pending: ${pending.length}`,
        "Preview order:",
        ...preview
      ].join("\n")
    );
    return;
  }

  if (command === "/admin_pendapatan") {
    const summary = getRevenueSummary();
    const resetInfo = summary.lastResetAt
      ? `Reset Terakhir (WIB): ${formatTimestampWib(summary.lastResetAt, config.displayTimezone)}`
      : "Reset Terakhir (WIB): belum pernah";

    await sendMessage(
      client,
      message.from,
      [
        "Dashboard Pendapatan",
        `Periode aktif order dibayar: ${summary.paidOrderCount}`,
        `Periode aktif total: ${formatCurrencyIdr(summary.totalRevenue)}`,
        "",
        `Semua waktu order dibayar: ${summary.allTimePaidOrderCount}`,
        `Semua waktu total: ${formatCurrencyIdr(summary.totalRevenueAllTime)}`,
        resetInfo
      ].join("\n")
    );
    return;
  }

  if (command === "/admin_reset_pendapatan") {
    const reset = resetRevenueSummary();
    await sendMessage(
      client,
      message.from,
      `Reset pendapatan berhasil. Waktu Reset (WIB): ${formatTimestampWib(reset.lastResetAt, config.displayTimezone)}`
    );
    return;
  }

  if (command === "/admin_cari") {
    const keyword = args.join(" ").trim();
    if (!keyword) {
      await sendMessage(client, message.from, "Gunakan: /admin_cari <username>");
      return;
    }

    const results = findByUsername(keyword);
    if (results.length === 0) {
      await sendMessage(client, message.from, "Akun tidak ditemukan.");
      return;
    }

    const preview = results.slice(0, 20).map((item) => `- ${item.account.username} [${item.source}]`);
    await sendMessage(client, message.from, [`Ditemukan ${results.length} akun:`, ...preview].join("\n"));
    return;
  }

  if (command === "/admin_set_status") {
    const username = args[0];
    const statusText = args[1];
    if (!username || !statusText) {
      await sendMessage(client, message.from, "Gunakan: /admin_set_status <username> <awaiting|ready>");
      return;
    }

    const statusMap = {
      awaiting: BENEFIT_STATUS.AWAITING,
      ready: BENEFIT_STATUS.READY
    };

    const nextStatus = statusMap[String(statusText || "").toLowerCase()];
    if (!nextStatus) {
      await sendMessage(client, message.from, "Status tidak valid. Gunakan awaiting atau ready.");
      return;
    }

    const updated = upsertBenefitStatusByUsername(username, nextStatus);
    if (!updated.ok) {
      await sendMessage(client, message.from, "Akun tidak ditemukan atau status tidak valid.");
      return;
    }

    await checkAndNotifyReadyStock(botAdapter, { reason: "ADMIN_SET_STATUS" });
    await sendMessage(
      client,
      message.from,
      [
        `Akun ${updated.account.username} berhasil diupdate.`,
        `Status: ${updated.account.benefitStatus}`,
        `Pindah dari: ${updated.previousSource}`,
        `Menjadi: ${updated.nextSource}`
      ].join("\n")
    );
    return;
  }

  if (command === "/admin_tambah") {
    const content = rawBody.replace(/^\/admin_tambah\s*/i, "").trim();
    if (!content) {
      await sendMessage(client, message.from, "Kirim format: /admin_tambah <blok akun>");
      return;
    }

    const parsed = parseSingleAccountText(content);
    if (!parsed) {
      await sendMessage(client, message.from, "Format akun tidak valid. Pastikan ada Username, Password, F2A.");
      return;
    }

    const saved = addReadyAccount(parsed);
    await checkAndNotifyReadyStock(botAdapter, { reason: "ADMIN_RESTOCK" });
    await sendMessage(client, message.from, `Akun ${saved.username} berhasil ditambahkan ke ready stock.`);
    return;
  }

  if (command === "/admin_broadcast") {
    const text = rawBody.replace(/^\/admin_broadcast\s*/i, "").trim();
    if (!text) {
      await sendMessage(client, message.from, "Gunakan: /admin_broadcast <pesan>");
      return;
    }

    const audience = getBroadcastAudience();
    if (audience.length === 0) {
      await sendMessage(client, message.from, "Belum ada pelanggan untuk broadcast.");
      return;
    }

    let sent = 0;
    let failed = 0;

    for (const target of audience) {
      try {
        await botAdapter.telegram.sendMessage(target.telegramId, `Broadcast dari Admin Store:\n\n${text}`);
        sent += 1;
      } catch (error) {
        failed += 1;
      }
    }

    await sendMessage(
      client,
      message.from,
      [
        "Broadcast selesai.",
        `Target audience: ${audience.length}`,
        `Terkirim: ${sent}`,
        `Gagal: ${failed}`
      ].join("\n")
    );
  }
}

async function startWhatsappBot() {
  const puppeteerConfig = {
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox"
    ]
  };

  if (config.whatsappPuppeteerExecutablePath) {
    puppeteerConfig.executablePath = config.whatsappPuppeteerExecutablePath;
  }

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: "bot-tele-whatsapp"
    }),
    puppeteer: puppeteerConfig
  });

  const botAdapter = buildBotAdapter(client);
  let webhookServer = null;

  client.on("qr", (qr) => {
    console.log("Scan QR WhatsApp berikut untuk login:");
    qrcode.generate(qr, { small: true });
  });

  client.on("ready", async () => {
    console.log("WhatsApp bot started");
    await checkAndNotifyReadyStock(botAdapter, { initializeOnly: true }).catch((error) => console.error(error));
    startDailyStatusCheck(botAdapter);
    webhookServer = startPaymentWebhookServer(botAdapter);
  });

  client.on("message", async (message) => {
    if (!message || !message.body || !message.from || String(message.from).includes("@g.us")) {
      return;
    }

    const body = String(message.body || "").trim();
    if (!body.startsWith("/")) {
      return;
    }

    const [commandRaw, ...args] = body.split(/\s+/);
    const command = String(commandRaw || "").toLowerCase();

    const senderPhone = getSenderPhone(message);
    touchCustomer({
      id: senderPhone,
      username: null,
      first_name: message._data && message._data.notifyName ? message._data.notifyName : null,
      last_name: null
    });

    try {
      if (command.startsWith("/admin")) {
        await handleAdminCommand(client, botAdapter, message, command, args, body);
      } else {
        await handleUserCommand(client, botAdapter, message, command, args);
      }
    } catch (error) {
      console.error("WhatsApp bot error:", error);
      await sendMessage(client, message.from, "Terjadi error internal. Silakan coba lagi.");
    }
  });

  await client.initialize();

  process.once("SIGINT", async () => {
    if (webhookServer) {
      webhookServer.close();
    }
    await client.destroy();
  });

  process.once("SIGTERM", async () => {
    if (webhookServer) {
      webhookServer.close();
    }
    await client.destroy();
  });
}

startWhatsappBot().catch((error) => {
  console.error(error);
  process.exit(1);
});
