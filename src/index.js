const { Telegraf } = require("telegraf");
const { config } = require("./config/env");
const { registerUserHandlers } = require("./bot/handlers/userHandlers");
const { registerAdminHandlers } = require("./bot/handlers/adminHandlers");
const { startDailyStatusCheck } = require("./services/schedulerService");
const { startPaymentWebhookServer } = require("./services/paymentWebhookServer");
const { touchCustomer } = require("./services/customerService");
const { checkAndNotifyReadyStock } = require("./services/adminNotificationService");

if (!config.botToken) {
  throw new Error("TELEGRAM_BOT_TOKEN belum diisi pada .env");
}

const bot = new Telegraf(config.botToken);
let webhookServer = null;

bot.use(async (ctx, next) => {
  if (ctx.from && ctx.from.id) {
    touchCustomer(ctx.from);
  }

  return next();
});

registerUserHandlers(bot);
registerAdminHandlers(bot);

bot.catch((error, ctx) => {
  console.error("Bot error:", error);
  if (ctx && typeof ctx.reply === "function") {
    ctx.reply("Terjadi error internal. Silakan coba lagi.");
  }
});

bot.launch().then(() => {
  console.log("Bot started");
  checkAndNotifyReadyStock(bot, { initializeOnly: true }).catch((error) => console.error(error));
  startDailyStatusCheck(bot);
  webhookServer = startPaymentWebhookServer(bot);
});

process.once("SIGINT", () => {
  bot.stop("SIGINT");
  if (webhookServer) {
    webhookServer.close();
  }
});

process.once("SIGTERM", () => {
  bot.stop("SIGTERM");
  if (webhookServer) {
    webhookServer.close();
  }
});
