function formatCurrencyIdr(amount) {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0
  }).format(amount);
}

function formatStockSummary({ readyCount, awaitingCount }) {
  return [
    `Ready: ${readyCount}`,
    `Awaiting benefits: ${awaitingCount}`
  ].join(" | ");
}

function formatTimestampWib(value, timezone = "Asia/Jakarta") {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  const formatted = new Intl.DateTimeFormat("id-ID", {
    timeZone: timezone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);

  return `${formatted} WIB`;
}

module.exports = {
  formatCurrencyIdr,
  formatStockSummary,
  formatTimestampWib
};
