const path = require("path");
const { config } = require("./env");

const paths = {
  readyAccounts: path.join(process.cwd(), "list_akun_ready.json"),
  awaitingAccounts: path.join(process.cwd(), "awaiting_benefits.json"),
  soldAccounts: path.join(process.cwd(), "terjual.json"),
  orders: path.join(config.dataDir, "orders.json"),
  revenueResetState: path.join(config.dataDir, "revenue_reset_state.json"),
  customers: path.join(config.dataDir, "customers.json"),
  stockAlertState: path.join(config.dataDir, "stock_alert_state.json"),
  benefitSnapshotHtml: path.join(process.cwd(), "benefit.html")
};

module.exports = { paths };
