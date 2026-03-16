const { config } = require("../config/env");
const { paths } = require("../config/paths");
const { safeReadJson, writeJson } = require("./jsonFileStore");
const { getStockSummary } = require("./accountService");
const { formatCurrencyIdr } = require("../utils/formatters");

async function notifyAdmins(bot, lines) {
  const text = Array.isArray(lines) ? lines.join("\n") : String(lines || "");
  const recipients = bot && bot.channel === "whatsapp"
    ? config.adminWhatsappNumbers
    : config.adminTelegramIds;

  for (const adminId of recipients) {
    try {
      await bot.telegram.sendMessage(adminId, text);
    } catch (error) {
      console.error("Failed to send admin notification", error.message);
    }
  }
}

async function notifyOrderCreated(bot, order) {
  if (!order) {
    return;
  }

  await notifyAdmins(bot, [
    "Notifikasi Order Baru",
    `Order: ${order.id}`,
    `Customer ID: ${order.telegramId}`,
    `Qty: ${order.quantity}`,
    `Total: ${formatCurrencyIdr(order.total)}`,
    `Status: ${order.status}`
  ]);
}

async function notifyOrderCompleted(bot, order) {
  if (!order) {
    return;
  }

  await notifyAdmins(bot, [
    "Notifikasi Order Selesai",
    `Order: ${order.id}`,
    `Customer ID: ${order.telegramId}`,
    `Nominal pendapatan: ${formatCurrencyIdr(order.total)}`,
    `Status: ${order.status}`
  ]);
}

function readStockAlertState() {
  return safeReadJson(paths.stockAlertState, {
    lastReadyCount: null,
    lowNotified: false
  });
}

function writeStockAlertState(state) {
  writeJson(paths.stockAlertState, state);
}

async function checkAndNotifyReadyStock(bot, options = {}) {
  const initializeOnly = Boolean(options.initializeOnly);
  const reason = options.reason || "UNKNOWN";
  const threshold = Number(config.lowStockThreshold || 3);

  const summary = getStockSummary();
  const currentReady = Number(summary.readyCount || 0);
  const state = readStockAlertState();

  if (initializeOnly && state.lastReadyCount === null) {
    writeStockAlertState({
      lastReadyCount: currentReady,
      lowNotified: currentReady <= threshold
    });
    return;
  }

  const prev = state.lastReadyCount;
  let lowNotified = Boolean(state.lowNotified);

  if (prev !== null && currentReady > prev) {
    await notifyAdmins(bot, [
      "Notifikasi Restock Ready",
      `Ready sebelumnya: ${prev}`,
      `Ready sekarang: ${currentReady}`,
      `Reason: ${reason}`
    ]);
  }

  if (currentReady <= threshold && !lowNotified) {
    await notifyAdmins(bot, [
      "Notifikasi Stok Menipis",
      `Stok ready saat ini: ${currentReady}`,
      `Threshold: ${threshold}`,
      "Segera lakukan restock."
    ]);
    lowNotified = true;
  }

  if (currentReady > threshold && lowNotified) {
    await notifyAdmins(bot, [
      "Notifikasi Stok Ready Pulih",
      `Stok ready saat ini: ${currentReady}`,
      `Threshold: ${threshold}`,
      `Reason: ${reason}`
    ]);
    lowNotified = false;
  }

  writeStockAlertState({
    lastReadyCount: currentReady,
    lowNotified
  });
}

module.exports = {
  notifyAdmins,
  notifyOrderCreated,
  notifyOrderCompleted,
  checkAndNotifyReadyStock
};
