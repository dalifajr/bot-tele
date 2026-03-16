const { paths } = require("../config/paths");
const { safeReadJson, writeJson } = require("./jsonFileStore");
const { formatTimestampWib } = require("../utils/formatters");

function getAuditTrail() {
  const rows = safeReadJson(paths.auditTrail, []);
  return Array.isArray(rows) ? rows : [];
}

function writeAuditTrail(rows) {
  writeJson(paths.auditTrail, rows);
}

function appendAdminAudit({ action, adminTelegramId, detail }) {
  const rows = getAuditTrail();
  const now = new Date().toISOString();

  rows.push({
    id: `AUD-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
    actorType: "ADMIN",
    action: String(action || "UNKNOWN_ACTION"),
    adminTelegramId: String(adminTelegramId || "unknown"),
    detail: detail && typeof detail === "object" ? detail : {},
    createdAt: now
  });

  const trimmed = rows.slice(-500);
  writeAuditTrail(trimmed);
  return trimmed[trimmed.length - 1];
}

function getRecentAdminAudits(limit = 10) {
  const rows = getAuditTrail().filter((row) => row && row.actorType === "ADMIN");
  const capped = Math.max(1, Math.min(50, Number(limit) || 10));
  return rows.slice(-capped).reverse();
}

function formatAdminAuditLine(entry, timezone) {
  const when = formatTimestampWib(entry.createdAt, timezone);
  return [
    `${when} | ${entry.action}`,
    `admin:${entry.adminTelegramId}`,
    `detail:${JSON.stringify(entry.detail || {})}`
  ].join(" | ");
}

module.exports = {
  appendAdminAudit,
  getRecentAdminAudits,
  formatAdminAuditLine
};