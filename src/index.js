const { Telegraf } = require("telegraf");
const { config } = require("./config/env");
const { registerUserHandlers } = require("./bot/handlers/userHandlers");
const { registerAdminHandlers } = require("./bot/handlers/adminHandlers");
const { startDailyStatusCheck } = require("./services/schedulerService");
const { startPaymentWebhookServer } = require("./services/paymentWebhookServer");

if (!config.botToken) {
  throw new Error("TELEGRAM_BOT_TOKEN belum diisi pada .env");
}

const bot = new Telegraf(config.botToken);
let webhookServer = null;

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
