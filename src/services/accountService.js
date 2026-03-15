const { v4: uuidv4 } = require("uuid");
const { paths } = require("../config/paths");
const { safeReadJson, writeJson } = require("./jsonFileStore");

const BENEFIT_STATUS = {
  READY: "READY",
  AWAITING: "AWAITING",
  APPLIED: "APPLIED"
};

function normalizeAccount(input) {
  const now = new Date().toISOString();
  return {
    id: input.id || `ACC-${uuidv4().slice(0, 8)}`,
    productName: input.productName || "GitHub Students Dev Pack",
    username: input.username,
    password: input.password,
    f2a: input.f2a,
    recoveryCodes: Array.isArray(input.recoveryCodes) ? input.recoveryCodes : [],
    createdAt: input.createdAt || null,
    readyAt: input.readyAt || null,
    seller: input.seller || null,
    benefitStatus: input.benefitStatus || BENEFIT_STATUS.AWAITING,
    insertedAt: input.insertedAt || now,
    benefitUpdatedAt: input.benefitUpdatedAt || now,
    benefitAppliedNotifiedAt: input.benefitAppliedNotifiedAt || null
  };
}

function getReadyAccounts() {
  return safeReadJson(paths.readyAccounts, []);
}

function getAwaitingAccounts() {
  return safeReadJson(paths.awaitingAccounts, []);
}

function getSoldAccounts() {
  return safeReadJson(paths.soldAccounts, []);
}

function getStockSummary() {
  return {
    readyCount: getReadyAccounts().length,
    awaitingCount: getAwaitingAccounts().length,
    soldCount: getSoldAccounts().length,
    appliedSoldCount: getSoldAccounts().filter((item) => item.benefitStatus === BENEFIT_STATUS.APPLIED).length
  };
}

function addReadyAccount(accountPayload) {
  const ready = getReadyAccounts();
  const next = normalizeAccount({ ...accountPayload, benefitStatus: BENEFIT_STATUS.READY });
  ready.push(next);
  writeJson(paths.readyAccounts, ready);
  return next;
}

function reserveReadyAccounts(quantity) {
  const ready = getReadyAccounts();
  if (quantity <= 0 || quantity > ready.length) {
    return [];
  }

  const reserved = ready.splice(0, quantity);
  writeJson(paths.readyAccounts, ready);
  return reserved;
}

function moveAccountsToSold(accounts, orderInfo) {
  const sold = getSoldAccounts();
  const now = new Date().toISOString();

  const soldItems = accounts.map((item) => ({
    ...item,
    soldAt: now,
    soldToTelegramId: orderInfo.telegramId,
    soldOrderId: orderInfo.orderId,
    soldPrice: orderInfo.pricePerAccount
  }));

  sold.push(...soldItems);
  writeJson(paths.soldAccounts, sold);
  return soldItems;
}

function moveReadyAccountsToSoldByIds(accountIds, orderInfo) {
  const idSet = new Set(accountIds || []);
  if (idSet.size === 0) {
    return [];
  }

  const ready = getReadyAccounts();
  const picked = [];
  const remaining = [];

  for (const account of ready) {
    if (idSet.has(account.id)) {
      picked.push(account);
    } else {
      remaining.push(account);
    }
  }

  if (picked.length === 0) {
    return [];
  }

  writeJson(paths.readyAccounts, remaining);
  return moveAccountsToSold(picked, orderInfo);
}

function findByUsername(username) {
  const needle = String(username || "").toLowerCase().trim();

  if (!needle) {
    return [];
  }

  const bucket = [
    { source: "ready", items: getReadyAccounts() },
    { source: "awaiting", items: getAwaitingAccounts() },
    { source: "sold", items: getSoldAccounts() }
  ];

  const results = [];
  for (const group of bucket) {
    for (const account of group.items) {
      if (String(account.username || "").toLowerCase().includes(needle)) {
        results.push({ source: group.source, account });
      }
    }
  }

  return results;
}

function getAccountById(accountId) {
  const needle = String(accountId || "").trim();
  if (!needle) {
    return null;
  }

  const bucket = [
    { source: "ready", items: getReadyAccounts() },
    { source: "awaiting", items: getAwaitingAccounts() },
    { source: "sold", items: getSoldAccounts() }
  ];

  for (const group of bucket) {
    const found = group.items.find((item) => String(item.id) === needle);
    if (found) {
      return {
        source: group.source,
        account: found
      };
    }
  }

  return null;
}

function upsertBenefitStatusById(accountId, nextStatus) {
  const status = String(nextStatus || "").toUpperCase();
  if (![BENEFIT_STATUS.AWAITING, BENEFIT_STATUS.APPLIED, BENEFIT_STATUS.READY].includes(status)) {
    return { ok: false, reason: "STATUS_INVALID" };
  }

  const needle = String(accountId || "").trim();
  if (!needle) {
    return { ok: false, reason: "ACCOUNT_ID_REQUIRED" };
  }

  const now = new Date().toISOString();

  const ready = getReadyAccounts();
  const awaiting = getAwaitingAccounts();
  const sold = getSoldAccounts();

  let found = null;
  let foundSource = null;

  const takeFrom = (list, sourceName) => {
    const idx = list.findIndex((item) => String(item.id) === needle);
    if (idx === -1) {
      return null;
    }

    const [item] = list.splice(idx, 1);
    found = item;
    foundSource = sourceName;
    return item;
  };

  takeFrom(ready, "ready") || takeFrom(awaiting, "awaiting") || takeFrom(sold, "sold");

  if (!found) {
    return { ok: false, reason: "NOT_FOUND" };
  }

  const updated = {
    ...found,
    benefitStatus: status,
    benefitUpdatedAt: now
  };

  if (status === BENEFIT_STATUS.AWAITING) {
    awaiting.push(updated);
  } else if (status === BENEFIT_STATUS.READY || status === BENEFIT_STATUS.APPLIED) {
    if (foundSource === "sold") {
      sold.push(updated);
    } else {
      ready.push(updated);
    }
  }

  writeJson(paths.readyAccounts, ready);
  writeJson(paths.awaitingAccounts, awaiting);
  writeJson(paths.soldAccounts, sold);

  return {
    ok: true,
    account: updated,
    previousSource: foundSource,
    nextSource: status === BENEFIT_STATUS.AWAITING ? "awaiting" : (foundSource === "sold" ? "sold" : "ready")
  };
}

function upsertBenefitStatusByUsername(username, nextStatus) {
  const status = String(nextStatus || "").toUpperCase();
  if (![BENEFIT_STATUS.AWAITING, BENEFIT_STATUS.APPLIED, BENEFIT_STATUS.READY].includes(status)) {
    return { ok: false, reason: "STATUS_INVALID" };
  }

  const needle = String(username || "").toLowerCase().trim();
  if (!needle) {
    return { ok: false, reason: "USERNAME_REQUIRED" };
  }

  const now = new Date().toISOString();

  const ready = getReadyAccounts();
  const awaiting = getAwaitingAccounts();
  const sold = getSoldAccounts();

  let found = null;
  let foundSource = null;

  const takeFrom = (list, sourceName) => {
    const idx = list.findIndex((item) => String(item.username || "").toLowerCase() === needle);
    if (idx === -1) {
      return null;
    }

    const [item] = list.splice(idx, 1);
    found = item;
    foundSource = sourceName;
    return item;
  };

  takeFrom(ready, "ready") || takeFrom(awaiting, "awaiting") || takeFrom(sold, "sold");

  if (!found) {
    return { ok: false, reason: "NOT_FOUND" };
  }

  const updated = {
    ...found,
    benefitStatus: status,
    benefitUpdatedAt: now
  };

  if (status === BENEFIT_STATUS.AWAITING) {
    awaiting.push(updated);
  } else if (status === BENEFIT_STATUS.READY || status === BENEFIT_STATUS.APPLIED) {
    if (foundSource === "sold") {
      sold.push(updated);
    } else {
      ready.push(updated);
    }
  }

  writeJson(paths.readyAccounts, ready);
  writeJson(paths.awaitingAccounts, awaiting);
  writeJson(paths.soldAccounts, sold);

  return {
    ok: true,
    account: updated,
    previousSource: foundSource,
    nextSource: status === BENEFIT_STATUS.AWAITING ? "awaiting" : (foundSource === "sold" ? "sold" : "ready")
  };
}

function markSoldAccountAppliedNotified(accountIds) {
  const ids = new Set(accountIds || []);
  if (ids.size === 0) {
    return;
  }

  const now = new Date().toISOString();
  const sold = getSoldAccounts();
  let changed = false;

  const next = sold.map((item) => {
    if (!ids.has(item.id)) {
      return item;
    }
    changed = true;
    return {
      ...item,
      benefitAppliedNotifiedAt: now
    };
  });

  if (changed) {
    writeJson(paths.soldAccounts, next);
  }
}

function getSoldAccountsNeedAppliedNotification() {
  const sold = getSoldAccounts();
  return sold.filter(
    (item) => item.benefitStatus === BENEFIT_STATUS.APPLIED && !item.benefitAppliedNotifiedAt && item.soldToTelegramId
  );
}

module.exports = {
  BENEFIT_STATUS,
  getReadyAccounts,
  getAwaitingAccounts,
  getSoldAccounts,
  getStockSummary,
  addReadyAccount,
  reserveReadyAccounts,
  moveAccountsToSold,
  moveReadyAccountsToSoldByIds,
  getAccountById,
  findByUsername,
  upsertBenefitStatusById,
  upsertBenefitStatusByUsername,
  getSoldAccountsNeedAppliedNotification,
  markSoldAccountAppliedNotified
};
