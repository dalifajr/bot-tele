const { config } = require("../../config/env");
const {
  addReadyAccount,
  getStockSummary,
  findByUsername,
  upsertBenefitStatusByUsername,
  BENEFIT_STATUS
} = require("../../services/accountService");
const {
  getPendingOrders,
  getRevenueSummary
} = require("../../services/orderService");
const { formatCurrencyIdr } = require("../../utils/formatters");
const { detectBenefitStatusFromSnapshotFile } = require("../../services/benefitHtmlService");

function isAdmin(ctx) {
  const id = ctx.from?.id;
  return config.adminTelegramIds.includes(String(id));
}

async function ensureAdmin(ctx) {
  if (isAdmin(ctx)) {
    return true;
  }

  await ctx.reply(
    [
      "Menu admin hanya untuk admin terdaftar.",
      `Telegram ID Anda: ${ctx.from?.id || "unknown"}`,
      "Pastikan ID tersebut ada di ADMIN_TELEGRAM_IDS lalu restart service bot."
    ].join("\n")
  );

  return false;
}

function renderAdminMenuHelp() {
  return [
    "Admin command:",
    "/admin_stok",
    "/admin_pending",
    "/admin_pendapatan",
    "/admin_cari <username>",
    "/admin_tambah <blok akun>",
    "/admin_set_status <username> <awaiting|ready|applied>",
    "/admin_parse_benefit <username>"
  ].join("\n");
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

function registerAdminHandlers(bot) {
  bot.command("admin", async (ctx) => {
    if (!(await ensureAdmin(ctx))) {
      return;
    }

    await ctx.reply(renderAdminMenuHelp());
  });

  bot.command("myid", async (ctx) => {
    await ctx.reply(`Telegram ID Anda: ${ctx.from?.id || "unknown"}`);
  });

  bot.command("admin_stok", async (ctx) => {
    if (!(await ensureAdmin(ctx))) {
      return;
    }

    const stock = getStockSummary();
    await ctx.reply(
      [
        "Panel stok:",
        `Ready: ${stock.readyCount}`,
        `Awaiting benefits: ${stock.awaitingCount}`,
        `Sold: ${stock.soldCount}`,
        `Sold (coupon applied): ${stock.appliedSoldCount}`
      ].join("\n")
    );
  });

  bot.command("admin_pending", async (ctx) => {
    if (!(await ensureAdmin(ctx))) {
      return;
    }

    const pending = getPendingOrders();
    await ctx.reply(`Total pending transaksi: ${pending.length}`);
  });

  bot.command("admin_pendapatan", async (ctx) => {
    if (!(await ensureAdmin(ctx))) {
      return;
    }

    const summary = getRevenueSummary();
    await ctx.reply(
      [
        "Ringkasan pendapatan:",
        `Order dibayar: ${summary.paidOrderCount}`,
        `Total pendapatan: ${formatCurrencyIdr(summary.totalRevenue)}`
      ].join("\n")
    );
  });

  bot.command("admin_cari", async (ctx) => {
    if (!(await ensureAdmin(ctx))) {
      return;
    }

    const [_, ...parts] = String(ctx.message?.text || "").split(" ");
    const keyword = parts.join(" ").trim();
    if (!keyword) {
      await ctx.reply("Gunakan: /admin_cari <username>");
      return;
    }

    const results = findByUsername(keyword);
    if (results.length === 0) {
      await ctx.reply("Akun tidak ditemukan.");
      return;
    }

    const formatted = results.slice(0, 20).map((item) => `- ${item.account.username} [${item.source}]`);
    await ctx.reply([`Ditemukan ${results.length} akun:`, ...formatted].join("\n"));
  });

  bot.command("admin_tambah", async (ctx) => {
    if (!(await ensureAdmin(ctx))) {
      return;
    }

    const raw = String(ctx.message?.text || "");
    const content = raw.replace(/^\/admin_tambah\s*/i, "").trim();
    if (!content) {
      await ctx.reply("Kirim format: /admin_tambah <blok akun>");
      return;
    }

    const parsed = parseSingleAccountText(content);
    if (!parsed) {
      await ctx.reply("Format akun tidak valid. Pastikan ada Username, Password, dan F2A.");
      return;
    }

    const saved = addReadyAccount(parsed);
    await ctx.reply(`Akun ${saved.username} berhasil ditambahkan ke ready stock.`);
  });

  bot.command("admin_set_status", async (ctx) => {
    if (!(await ensureAdmin(ctx))) {
      return;
    }

    const [_, username, statusText] = String(ctx.message?.text || "").split(" ");
    if (!username || !statusText) {
      await ctx.reply("Gunakan: /admin_set_status <username> <awaiting|ready|applied>");
      return;
    }

    const statusMap = {
      awaiting: BENEFIT_STATUS.AWAITING,
      ready: BENEFIT_STATUS.READY,
      applied: BENEFIT_STATUS.APPLIED
    };

    const nextStatus = statusMap[String(statusText || "").toLowerCase()];
    if (!nextStatus) {
      await ctx.reply("Status tidak valid. Gunakan salah satu: awaiting, ready, applied.");
      return;
    }

    const updated = upsertBenefitStatusByUsername(username, nextStatus);
    if (!updated.ok) {
      await ctx.reply("Akun tidak ditemukan atau status tidak valid.");
      return;
    }

    await ctx.reply(
      [
        `Akun ${updated.account.username} berhasil diupdate.`,
        `Status benefit: ${updated.account.benefitStatus}`,
        `Pindah dari: ${updated.previousSource}`,
        `Menjadi: ${updated.nextSource}`
      ].join("\n")
    );
  });

  bot.command("admin_parse_benefit", async (ctx) => {
    if (!(await ensureAdmin(ctx))) {
      return;
    }

    const [_, username] = String(ctx.message?.text || "").split(" ");
    if (!username) {
      await ctx.reply("Gunakan: /admin_parse_benefit <username>");
      return;
    }

    const parsedStatus = detectBenefitStatusFromSnapshotFile();
    if (!parsedStatus) {
      await ctx.reply("Status tidak terdeteksi dari benefit.html");
      return;
    }

    const updated = upsertBenefitStatusByUsername(username, parsedStatus);
    if (!updated.ok) {
      await ctx.reply("Akun tidak ditemukan untuk username tersebut.");
      return;
    }

    await ctx.reply(
      [
        `Snapshot benefit berhasil diproses untuk ${updated.account.username}.`,
        `Status baru: ${updated.account.benefitStatus}`,
        `Source data: benefit.html`
      ].join("\n")
    );
  });
}

module.exports = {
  registerAdminHandlers,
  isAdmin
};
