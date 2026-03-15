const http = require("http");
const crypto = require("crypto");
const { config } = require("../config/env");
const { getOrderById, markOrderPaidFromWebhook, ORDER_STATUS } = require("./orderService");
const { deliverOrderAccounts } = require("./deliveryService");

function verifySignature(rawBody, signature) {
  const expected = crypto
    .createHmac("sha256", config.paymentWebhookSecret)
    .update(rawBody)
    .digest("hex");

  return String(signature || "").trim() === expected;
}

function sendJson(res, code, payload) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

function startPaymentWebhookServer(bot) {
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method !== "POST" || req.url !== "/webhook/payment") {
      sendJson(res, 404, { ok: false, message: "Not found" });
      return;
    }

    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));

    req.on("end", async () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const signature = req.headers["x-signature"];

      if (!verifySignature(rawBody, signature)) {
        sendJson(res, 401, { ok: false, message: "Invalid signature" });
        return;
      }

      let payload;
      try {
        payload = JSON.parse(rawBody);
      } catch (error) {
        sendJson(res, 400, { ok: false, message: "Invalid JSON" });
        return;
      }

      const orderId = payload.orderId;
      const status = String(payload.status || "").toUpperCase();
      const paymentReference = payload.paymentReference;

      const order = getOrderById(orderId);
      if (!order) {
        sendJson(res, 404, { ok: false, message: "Order not found" });
        return;
      }

      if (status !== "PAID") {
        sendJson(res, 200, { ok: true, ignored: true, message: "Status ignored" });
        return;
      }

      const paidOrder = markOrderPaidFromWebhook(orderId, paymentReference);

      if (!paidOrder) {
        sendJson(res, 500, { ok: false, message: "Failed to mark order as paid" });
        return;
      }

      if (paidOrder.status === ORDER_STATUS.DELIVERED) {
        sendJson(res, 200, { ok: true, message: "Already delivered" });
        return;
      }

      const delivery = await deliverOrderAccounts(bot, paidOrder);
      if (!delivery.ok) {
        sendJson(res, 409, { ok: false, message: delivery.reason });
        return;
      }

      sendJson(res, 200, { ok: true, deliveredCount: delivery.deliveredCount });
    });
  });

  server.listen(config.appPort, () => {
    console.log(`Payment webhook server listening on port ${config.appPort}`);
  });

  return server;
}

module.exports = {
  startPaymentWebhookServer,
  verifySignature
};
