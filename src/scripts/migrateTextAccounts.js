const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const ROOT = process.cwd();
const SOURCE = path.join(ROOT, "awaiting_benefits.json");
const READY_FILE = path.join(ROOT, "list_akun_ready.json");
const AWAITING_FILE = path.join(ROOT, "awaiting_benefits.json");
const SOLD_FILE = path.join(ROOT, "terjual.json");

function parseBlocks(raw) {
  const chunks = raw
    .split("*GitHub Students Dev Pack*")
    .map((item) => item.trim())
    .filter(Boolean);

  return chunks.map((chunk) => {
    const lines = chunk.split(/\r?\n/).map((line) => line.trim());

    const getValue = (prefix) => {
      const found = lines.find((line) => line.toLowerCase().startsWith(prefix));
      return found ? found.split(":").slice(1).join(":").trim() : null;
    };

    const recoveryIndex = lines.findIndex((line) => line.toLowerCase() === "recovery codes:");
    const recoveryCodes = [];

    if (recoveryIndex !== -1) {
      for (let i = recoveryIndex + 1; i < lines.length; i += 1) {
        const line = lines[i];
        if (!line) {
          continue;
        }
        if (line.includes(":") || line.startsWith("_")) {
          break;
        }
        recoveryCodes.push(line);
      }
    }

    return {
      id: `ACC-${uuidv4().slice(0, 8)}`,
      productName: "GitHub Students Dev Pack",
      username: getValue("username:"),
      password: getValue("password:"),
      f2a: getValue("f2a:"),
      recoveryCodes,
      createdAt: getValue("created at:"),
      readyAt: getValue("ready at:"),
      seller: "dzulfikrialifajri store",
      benefitStatus: "AWAITING",
      insertedAt: new Date().toISOString()
    };
  }).filter((item) => item.username && item.password && item.f2a);
}

function main() {
  if (!fs.existsSync(SOURCE)) {
    throw new Error("Source file awaiting_benefits.json tidak ditemukan");
  }

  const raw = fs.readFileSync(SOURCE, "utf8");
  const looksLikeJson = raw.trim().startsWith("[") || raw.trim().startsWith("{");

  if (looksLikeJson) {
    console.log("Source sudah JSON, migrasi dilewati.");
    return;
  }

  const parsed = parseBlocks(raw);

  fs.writeFileSync(READY_FILE, JSON.stringify([], null, 2));
  fs.writeFileSync(AWAITING_FILE, JSON.stringify(parsed, null, 2));

  if (!fs.existsSync(SOLD_FILE)) {
    fs.writeFileSync(SOLD_FILE, JSON.stringify([], null, 2));
  }

  console.log(`Migrasi selesai. Total akun awaiting: ${parsed.length}`);
}

main();
