const { config } = require("../config/env");
const {
  getStockSummary,
  getSoldAccountsNeedAppliedNotification,
  markSoldAccountAppliedNotified
} = require("./accountService");
const { expireOverdueOrders, getOrderSummaryByStatus } = require("./orderService");

const DAY_MS = 24 * 60 * 60 * 1000;

function startDailyStatusCheck(bot) {
  async function reconcileExpiredOrders() {
    const result = expireOverdueOrders();
    if (!result.changed || result.expiredCount <= 0) {
      return;
    }

    for (const adminId of config.adminTelegramIds) {
      try {
        await bot.telegram.sendMessage(
          adminId,
          `Order expired reconciliation: ${result.expiredCount} order diubah menjadi EXPIRED.`
        );
      } catch (error) {
        console.error("Failed to notify admin for expired reconciliation", error.message);
      }
    }
  }

  async function tick() {
    await reconcileExpiredOrders();

    const summary = getStockSummary();
    const pendingAppliedNotify = getSoldAccountsNeedAppliedNotification();
    const orderSummary = getOrderSummaryByStatus();

    const text = [
      "Daily status check reminder:",
      `Ready: ${summary.readyCount}`,
      `Awaiting benefits: ${summary.awaitingCount}`,
      `Sold: ${summary.soldCount}`,
      `Sold with coupon applied: ${summary.appliedSoldCount}`,
      `Applied notifications pending: ${pendingAppliedNotify.length}`,
      `Orders pending: ${orderSummary.pending}`,
      `Orders expired: ${orderSummary.expired}`,
      `Orders delivery failed: ${orderSummary.deliveryFailed}`,
      "Action: jalankan checker akun GitHub untuk update coupon status."
    ].join("\n");

    for (const adminId of config.adminTelegramIds) {
      try {
        await bot.telegram.sendMessage(adminId, text);
      } catch (error) {
        console.error("Failed to notify admin daily check", error.message);
      }
    }

    if (pendingAppliedNotify.length > 0) {
      const notifiedIds = [];
      for (const account of pendingAppliedNotify) {
        try {
          await bot.telegram.sendMessage(
            account.soldToTelegramId,
            [
              "Update akun GitHub Student Dev Pack:",
              `Username: ${account.username}`,
              "Status benefit: Coupon applied"
            ].join("\n")
          );
          notifiedIds.push(account.id);
        } catch (error) {
          console.error("Failed to notify user applied status", error.message);
        }
      }

      markSoldAccountAppliedNotified(notifiedIds);
    }
  }

  // Run first check 60 seconds after start to verify scheduler works.
  setTimeout(() => {
    tick().catch((error) => console.error(error));
  }, 60000);

  setInterval(() => {
    tick().catch((error) => console.error(error));
  }, DAY_MS);

  // Keep pending payment list clean by expiring overdue invoices every minute.
  setInterval(() => {
    reconcileExpiredOrders().catch((error) => console.error(error));
  }, 60 * 1000);
}

module.exports = {
  startDailyStatusCheck
};
