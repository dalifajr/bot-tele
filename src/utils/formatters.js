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

module.exports = {
  formatCurrencyIdr,
  formatStockSummary
};
