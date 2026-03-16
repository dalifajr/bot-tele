const fs = require("fs");
const path = require("path");

const files = [
  "list_akun_ready.json",
  "awaiting_benefits.json",
  "terjual.json",
  path.join("data", "orders.json"),
  path.join("data", "revenue_reset_state.json"),
  path.join("data", "session_state.json"),
  path.join("data", "customers.json"),
  path.join("data", "stock_alert_state.json")
];

function ensureJsonFile(filePath, fallback = []) {
  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(fallback, null, 2));
    return;
  }

  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) {
    fs.writeFileSync(filePath, JSON.stringify(fallback, null, 2));
    return;
  }

  JSON.parse(raw);
}

function run() {
  for (const file of files) {
    const full = path.join(process.cwd(), file);
    const fallback = file.endsWith("stock_alert_state.json")
      ? { lastReadyCount: null, lowNotified: false }
      : file.endsWith("revenue_reset_state.json")
        ? { lastResetAt: null }
        : file.endsWith("session_state.json")
          ? {
            userCheckoutQty: {},
            userLastOrderId: {},
            adminInputState: {},
            adminMassState: {}
          }
      : [];
    ensureJsonFile(full, fallback);
  }

  console.log("Semua file data valid.");
}

run();
