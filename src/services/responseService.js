function toText(lines) {
  return lines
    .filter((line) => line !== null && line !== undefined && String(line).trim() !== "")
    .map((line) => String(line))
    .join("\n");
}

function internalErrorMessage() {
  return toText([
    "Terjadi error internal.",
    "Silakan coba lagi dalam beberapa saat."
  ]);
}

function adminOnlyMessage(telegramId) {
  return toText([
    "Menu admin hanya untuk admin terdaftar.",
    `Telegram ID Anda: ${telegramId || "unknown"}`,
    "Pastikan ID tersebut ada di ADMIN_TELEGRAM_IDS lalu restart service bot."
  ]);
}

function invalidUsageMessage(usageText) {
  return toText([`Gunakan: ${usageText}`]);
}

function orderNotFoundMessage() {
  return "Order tidak ditemukan.";
}

function orderNotOwnedMessage() {
  return "Order ini bukan milik Anda.";
}

function accountNotFoundMessage() {
  return "Akun tidak ditemukan.";
}

function invalidPriceMessage() {
  return "Nominal tidak valid. Masukkan angka saja.";
}

module.exports = {
  internalErrorMessage,
  adminOnlyMessage,
  invalidUsageMessage,
  orderNotFoundMessage,
  orderNotOwnedMessage,
  accountNotFoundMessage,
  invalidPriceMessage
};