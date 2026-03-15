const { v4: uuidv4 } = require("uuid");
const { config } = require("../config/env");
const { paths } = require("../config/paths");
const { safeReadJson, writeJson } = require("./jsonFileStore");

const ORDER_STATUS = {
  PENDING_PAYMENT: "PENDING_PAYMENT",
  PAID: "PAID",
  DELIVERED: "DELIVERED",
  CANCELLED: "CANCELLED"
};

function listOrders() {
  return safeReadJson(paths.orders, []);
}

function saveOrders(orders) {
  writeJson(paths.orders, orders);
}

function createOrder({ telegramId, quantity, reservedAccounts }) {
  const now = new Date();
  const orderId = `ORD-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${uuidv4().slice(0, 8).toUpperCase()}`;
  const total = quantity * config.productPriceIdr;
  const invoiceId = `INV-${uuidv4().slice(0, 12).toUpperCase()}`;

  const order = {
    id: orderId,
    telegramId,
    quantity,
    reservedAccounts: reservedAccounts || [],
    total,
    status: ORDER_STATUS.PENDING_PAYMENT,
    payment: {
      provider: config.qrisProvider,
      invoiceId,
      invoiceUrl: `${config.publicBaseUrl}/pay/${invoiceId}`,
      qrString: `QRIS-${invoiceId}-${total}`,
      paidAt: null,
      paidReference: null,
      expiresAt: new Date(Date.now() + config.invoiceExpireMinutes * 60 * 1000).toISOString()
    },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  };

  const orders = listOrders();
  orders.push(order);
  saveOrders(orders);

  return order;
}

function markOrderPaid(orderId) {
  const orders = listOrders();
  const idx = orders.findIndex((item) => item.id === orderId);

  if (idx === -1) {
    return null;
  }

  if (orders[idx].status !== ORDER_STATUS.PENDING_PAYMENT) {
    return orders[idx];
  }

  orders[idx].status = ORDER_STATUS.PAID;
  orders[idx].payment.paidAt = new Date().toISOString();
  orders[idx].payment.paidReference = orders[idx].payment.paidReference || `SIM-${uuidv4().slice(0, 10).toUpperCase()}`;
  orders[idx].updatedAt = new Date().toISOString();
  saveOrders(orders);
  return orders[idx];
}

function markOrderPaidFromWebhook(orderId, paymentReference) {
  const orders = listOrders();
  const idx = orders.findIndex((item) => item.id === orderId);

  if (idx === -1) {
    return null;
  }

  if (orders[idx].status !== ORDER_STATUS.PENDING_PAYMENT) {
    return orders[idx];
  }

  orders[idx].status = ORDER_STATUS.PAID;
  orders[idx].payment.paidAt = new Date().toISOString();
  orders[idx].payment.paidReference = paymentReference || `WEB-${uuidv4().slice(0, 10).toUpperCase()}`;
  orders[idx].updatedAt = new Date().toISOString();
  saveOrders(orders);

  return orders[idx];
}

function markOrderDelivered(orderId) {
  const orders = listOrders();
  const idx = orders.findIndex((item) => item.id === orderId);

  if (idx === -1) {
    return null;
  }

  if (orders[idx].status !== ORDER_STATUS.PAID) {
    return null;
  }

  orders[idx].status = ORDER_STATUS.DELIVERED;
  orders[idx].updatedAt = new Date().toISOString();
  saveOrders(orders);
  return orders[idx];
}

function getOrderById(orderId) {
  return listOrders().find((item) => item.id === orderId) || null;
}

function getPendingOrders() {
  return listOrders().filter((item) => item.status === ORDER_STATUS.PENDING_PAYMENT);
}

function getRevenueSummary() {
  const paid = listOrders().filter((item) => item.status === ORDER_STATUS.PAID || item.status === ORDER_STATUS.DELIVERED);
  const totalRevenue = paid.reduce((sum, row) => sum + Number(row.total || 0), 0);
  return {
    totalRevenue,
    paidOrderCount: paid.length
  };
}

module.exports = {
  ORDER_STATUS,
  listOrders,
  createOrder,
  getOrderById,
  markOrderPaid,
  markOrderPaidFromWebhook,
  markOrderDelivered,
  getPendingOrders,
  getRevenueSummary
};
