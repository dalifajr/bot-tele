const fs = require("fs");
const path = require("path");

function ensureDirForFile(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function safeReadJson(filePath, fallbackValue) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallbackValue;
    }

    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) {
      return fallbackValue;
    }

    return JSON.parse(raw);
  } catch (error) {
    return fallbackValue;
  }
}

function writeJson(filePath, value) {
  ensureDirForFile(filePath);
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

module.exports = {
  safeReadJson,
  writeJson
};
