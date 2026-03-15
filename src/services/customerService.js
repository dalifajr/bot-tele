const { paths } = require("../config/paths");
const { config } = require("../config/env");
const { safeReadJson, writeJson } = require("./jsonFileStore");

function listCustomers() {
  return safeReadJson(paths.customers, []);
}

function saveCustomers(customers) {
  writeJson(paths.customers, customers);
}

function touchCustomer(from) {
  const telegramId = String(from?.id || "").trim();
  if (!telegramId) {
    return null;
  }

  const customers = listCustomers();
  const idx = customers.findIndex((item) => String(item.telegramId) === telegramId);
  const now = new Date().toISOString();
  const isAdmin = config.adminTelegramIds.includes(telegramId);

  if (idx === -1) {
    const next = {
      telegramId,
      username: from?.username || null,
      firstName: from?.first_name || null,
      lastName: from?.last_name || null,
      isAdmin,
      firstInteractionAt: now,
      lastInteractionAt: now,
      interactionCount: 1
    };
    customers.push(next);
    saveCustomers(customers);
    return next;
  }

  const current = customers[idx];
  const updated = {
    ...current,
    username: from?.username || current.username || null,
    firstName: from?.first_name || current.firstName || null,
    lastName: from?.last_name || current.lastName || null,
    isAdmin,
    lastInteractionAt: now,
    interactionCount: Number(current.interactionCount || 0) + 1
  };

  customers[idx] = updated;
  saveCustomers(customers);
  return updated;
}

function getBroadcastAudience() {
  const customers = listCustomers();
  return customers.filter((item) => !item.isAdmin);
}

module.exports = {
  listCustomers,
  touchCustomer,
  getBroadcastAudience
};
