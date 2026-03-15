const fs = require("fs");
const path = require("path");

const files = [
  "list_akun_ready.json",
  "awaiting_benefits.json",
  "terjual.json",
  path.join("data", "orders.json")
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
    ensureJsonFile(full, []);
  }

  console.log("Semua file data valid.");
}

run();
