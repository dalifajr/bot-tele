const { config } = require("../config/env");
const { moveReadyAccountsToSoldByIds } = require("./accountService");
const { markOrderDelivered } = require("./orderService");

function buildDeliveryText(order, account) {
  const lines = [
    `*${config.productName}*`,
    `Username: ${account.username}`,
    `Password: ${account.password}`,
    `F2A: ${account.f2a}`,
    "",
    "Recovery Codes:"
  ];

  for (const code of account.recoveryCodes || []) {
    lines.push(code);
  }

  lines.push("", `Order: ${order.id}`);
  return lines.join("\n");
}

async function deliverOrderAccounts(bot, order) {
  const sold = moveReadyAccountsToSoldByIds(order.reservedAccounts, {
    telegramId: order.telegramId,
    orderId: order.id,
    pricePerAccount: config.productPriceIdr
  });

  if (sold.length === 0) {
    await bot.telegram.sendMessage(order.telegramId, "Akun untuk order ini sudah tidak tersedia. Hubungi admin.");
    return {
      ok: false,
      reason: "STOCK_MISSING"
    };
  }

  for (const account of sold) {
    await bot.telegram.sendDocument(
      order.telegramId,
      {
        source: Buffer.from(buildDeliveryText(order, account), "utf8"),
        filename: `${account.username}-${order.id}.txt`
      },
      {
        caption: `Detail akun untuk ${account.username}`
      }
    );
  }

  markOrderDelivered(order.id);

  return {
    ok: true,
    deliveredCount: sold.length
  };
}

module.exports = {
  deliverOrderAccounts,
  buildDeliveryText
};
