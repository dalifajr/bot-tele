const { v4: uuidv4 } = require("uuid");
const { config } = require("../config/env");
const { paths } = require("../config/paths");
const { safeReadJson, writeJson } = require("./jsonFileStore");

const ORDER_STATUS = {
  PENDING_PAYMENT: "PENDING_PAYMENT",
  PAID: "PAID",
  DELIVERED: "DELIVERED",
  DELIVERY_FAILED: "DELIVERY_FAILED",
  EXPIRED: "EXPIRED",
  CANCELLED: "CANCELLED"
};

function nowIso() {
  return new Date().toISOString();
}

function normalizeOrderShape(order) {
  const normalized = {
    ...order,
    payment: {
      provider: order?.payment?.provider || config.qrisProvider,
      invoiceId: order?.payment?.invoiceId || null,
      invoiceUrl: order?.payment?.invoiceUrl || null,
      qrString: order?.payment?.qrString || null,
      paidAt: order?.payment?.paidAt || null,
      paidReference: order?.payment?.paidReference || null,
      expiresAt: order?.payment?.expiresAt || null,
      receivedReferences: Array.isArray(order?.payment?.receivedReferences)
        ? order.payment.receivedReferences
        : (order?.payment?.paidReference ? [order.payment.paidReference] : [])
    },
    delivery: {
      attempts: Number(order?.delivery?.attempts || 0),
      deliveredAt: order?.delivery?.deliveredAt || null,
      lastAttemptAt: order?.delivery?.lastAttemptAt || null,
      lastError: order?.delivery?.lastError || null
    }
  };

  return normalized;
}

function isOrderPayable(order) {
  return order.status === ORDER_STATUS.PENDING_PAYMENT;
}

function isExpired(order) {
  if (!order?.payment?.expiresAt) {
    return false;
  }

  const exp = Date.parse(order.payment.expiresAt);
  if (Number.isNaN(exp)) {
    return false;
  }

  return exp < Date.now();
}

function listOrders() {
  const raw = safeReadJson(paths.orders, []);
  return raw.map(normalizeOrderShape);
}

function saveOrders(orders) {
  writeJson(paths.orders, orders);
}

function readRevenueResetState() {
  return safeReadJson(paths.revenueResetState, {
    lastResetAt: null
  });
}

function saveRevenueResetState(state) {
  writeJson(paths.revenueResetState, {
    lastResetAt: state && state.lastResetAt ? String(state.lastResetAt) : null
  });
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
      receivedReferences: [],
      expiresAt: new Date(Date.now() + config.invoiceExpireMinutes * 60 * 1000).toISOString()
    },
    delivery: {
      attempts: 0,
      deliveredAt: null,
      lastAttemptAt: null,
      lastError: null
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

  if (!isOrderPayable(orders[idx])) {
    return orders[idx];
  }

  if (isExpired(orders[idx])) {
    orders[idx].status = ORDER_STATUS.EXPIRED;
    orders[idx].updatedAt = nowIso();
    saveOrders(orders);
    return orders[idx];
  }

  orders[idx].status = ORDER_STATUS.PAID;
  orders[idx].payment.paidAt = nowIso();
  orders[idx].payment.paidReference = orders[idx].payment.paidReference || `SIM-${uuidv4().slice(0, 10).toUpperCase()}`;
  if (!orders[idx].payment.receivedReferences.includes(orders[idx].payment.paidReference)) {
    orders[idx].payment.receivedReferences.push(orders[idx].payment.paidReference);
  }
  orders[idx].updatedAt = nowIso();
  saveOrders(orders);
  return orders[idx];
}

function markOrderPaidFromWebhook(orderId, paymentReference) {
  const orders = listOrders();
  const idx = orders.findIndex((item) => item.id === orderId);

  if (idx === -1) {
    return { order: null, updated: false, duplicate: false, reason: "NOT_FOUND" };
  }

  const current = orders[idx];
  const normalizedRef = paymentReference || `WEB-${uuidv4().slice(0, 10).toUpperCase()}`;

  if (
    (current.status === ORDER_STATUS.PAID || current.status === ORDER_STATUS.DELIVERED || current.status === ORDER_STATUS.DELIVERY_FAILED) &&
    (current.payment.paidReference === normalizedRef || current.payment.receivedReferences.includes(normalizedRef))
  ) {
    return { order: current, updated: false, duplicate: true, reason: "DUPLICATE_REFERENCE" };
  }

  if (!isOrderPayable(current)) {
    return { order: current, updated: false, duplicate: false, reason: "NOT_PAYABLE" };
  }

  if (isExpired(current)) {
    orders[idx].status = ORDER_STATUS.EXPIRED;
    orders[idx].updatedAt = nowIso();
    saveOrders(orders);
    return { order: orders[idx], updated: true, duplicate: false, reason: "EXPIRED" };
  }

  if (!orders[idx].payment.receivedReferences.includes(normalizedRef)) {
    orders[idx].payment.receivedReferences.push(normalizedRef);
  }

  orders[idx].status = ORDER_STATUS.PAID;
  orders[idx].payment.paidAt = nowIso();
  orders[idx].payment.paidReference = normalizedRef;
  orders[idx].updatedAt = nowIso();
  saveOrders(orders);

  return { order: orders[idx], updated: true, duplicate: false, reason: null };
}

function markOrderDelivered(orderId) {
  const orders = listOrders();
  const idx = orders.findIndex((item) => item.id === orderId);

  if (idx === -1) {
    return null;
  }

  if (orders[idx].status !== ORDER_STATUS.PAID && orders[idx].status !== ORDER_STATUS.DELIVERY_FAILED) {
    return null;
  }

  orders[idx].status = ORDER_STATUS.DELIVERED;
  orders[idx].delivery.deliveredAt = nowIso();
  orders[idx].delivery.lastError = null;
  orders[idx].updatedAt = nowIso();
  saveOrders(orders);
  return orders[idx];
}

function markOrderDeliveryAttempt(orderId) {
  const orders = listOrders();
  const idx = orders.findIndex((item) => item.id === orderId);

  if (idx === -1) {
    return null;
  }

  orders[idx].delivery.attempts = Number(orders[idx].delivery.attempts || 0) + 1;
  orders[idx].delivery.lastAttemptAt = nowIso();
  orders[idx].updatedAt = nowIso();
  saveOrders(orders);
  return orders[idx];
}

function markOrderDeliveryFailed(orderId, errorMessage) {
  const orders = listOrders();
  const idx = orders.findIndex((item) => item.id === orderId);

  if (idx === -1) {
    return null;
  }

  if (orders[idx].status === ORDER_STATUS.DELIVERED) {
    return orders[idx];
  }

  orders[idx].status = ORDER_STATUS.DELIVERY_FAILED;
  orders[idx].delivery.lastError = String(errorMessage || "DELIVERY_FAILED");
  orders[idx].updatedAt = nowIso();
  saveOrders(orders);
  return orders[idx];
}

function expireOverdueOrders() {
  const orders = listOrders();
  let changed = false;
  let expiredCount = 0;

  const next = orders.map((order) => {
    if (order.status !== ORDER_STATUS.PENDING_PAYMENT) {
      return order;
    }

    if (!isExpired(order)) {
      return order;
    }

    changed = true;
    expiredCount += 1;
    return {
      ...order,
      status: ORDER_STATUS.EXPIRED,
      updatedAt: nowIso()
    };
  });

  if (changed) {
    saveOrders(next);
  }

  return {
    changed,
    expiredCount
  };
}

function getOrderById(orderId) {
  return listOrders().find((item) => item.id === orderId) || null;
}

function getPendingOrders() {
  return listOrders().filter((item) => item.status === ORDER_STATUS.PENDING_PAYMENT && !isExpired(item));
}

function cancelOrderById(orderId, reason = "ADMIN_CANCELLED") {
  const orders = listOrders();
  const idx = orders.findIndex((item) => item.id === orderId);

  if (idx === -1) {
    return { ok: false, reason: "NOT_FOUND" };
  }

  if (orders[idx].status !== ORDER_STATUS.PENDING_PAYMENT) {
    return { ok: false, reason: "NOT_PENDING", order: orders[idx] };
  }

  orders[idx].status = ORDER_STATUS.CANCELLED;
  orders[idx].cancelledAt = nowIso();
  orders[idx].cancelReason = String(reason || "ADMIN_CANCELLED");
  orders[idx].updatedAt = nowIso();
  saveOrders(orders);

  return { ok: true, order: orders[idx] };
}

function getRevenueSummary() {
  const paid = listOrders().filter((item) => item.status === ORDER_STATUS.PAID || item.status === ORDER_STATUS.DELIVERED);
  const totalRevenueAllTime = paid.reduce((sum, row) => sum + Number(row.total || 0), 0);
  const allTimePaidOrderCount = paid.length;

  const resetState = readRevenueResetState();
  const resetAtMs = resetState.lastResetAt ? Date.parse(resetState.lastResetAt) : NaN;

  const paidSinceReset = Number.isNaN(resetAtMs)
    ? paid
    : paid.filter((item) => {
      const paidAtMs = Date.parse(item?.payment?.paidAt || "");
      return !Number.isNaN(paidAtMs) && paidAtMs >= resetAtMs;
    });

  const totalRevenueSinceReset = paidSinceReset.reduce((sum, row) => sum + Number(row.total || 0), 0);

  return {
    totalRevenue: totalRevenueSinceReset,
    paidOrderCount: paidSinceReset.length,
    totalRevenueAllTime,
    allTimePaidOrderCount,
    lastResetAt: resetState.lastResetAt || null
  };
}

function resetRevenueSummary() {
  const now = nowIso();
  saveRevenueResetState({
    lastResetAt: now
  });
  return {
    lastResetAt: now
  };
}

function getOrderSummaryByStatus() {
  const orders = listOrders();
  const summary = {
    total: orders.length,
    pending: 0,
    paid: 0,
    delivered: 0,
    deliveryFailed: 0,
    expired: 0,
    cancelled: 0
  };

  for (const order of orders) {
    if (order.status === ORDER_STATUS.PENDING_PAYMENT) {
      if (isExpired(order)) {
        summary.expired += 1;
      } else {
        summary.pending += 1;
      }
    } else if (order.status === ORDER_STATUS.PAID) {
      summary.paid += 1;
    } else if (order.status === ORDER_STATUS.DELIVERED) {
      summary.delivered += 1;
    } else if (order.status === ORDER_STATUS.DELIVERY_FAILED) {
      summary.deliveryFailed += 1;
    } else if (order.status === ORDER_STATUS.EXPIRED) {
      summary.expired += 1;
    } else if (order.status === ORDER_STATUS.CANCELLED) {
      summary.cancelled += 1;
    }
  }

  return summary;
}

module.exports = {
  ORDER_STATUS,
  listOrders,
  createOrder,
  getOrderById,
  markOrderPaid,
  markOrderPaidFromWebhook,
  markOrderDelivered,
  markOrderDeliveryAttempt,
  markOrderDeliveryFailed,
  expireOverdueOrders,
  getPendingOrders,
  cancelOrderById,
  getRevenueSummary,
  resetRevenueSummary,
  getOrderSummaryByStatus
};
