const fs = require("fs");
const path = require("path");
const { config } = require("../config/env");

const ENV_FILE = path.join(process.cwd(), ".env");

function normalizePriceInput(input) {
  const digits = String(input || "").replace(/\D/g, "");
  const value = Number(digits);

  if (!Number.isInteger(value) || value <= 0) {
    return null;
  }

  return value;
}

function persistPriceToEnv(price) {
  const line = `PRODUCT_PRICE_IDR=${price}`;

  if (!fs.existsSync(ENV_FILE)) {
    fs.writeFileSync(ENV_FILE, `${line}\n`, "utf8");
    return { persisted: true, created: true };
  }

  const raw = fs.readFileSync(ENV_FILE, "utf8");
  if (/^PRODUCT_PRICE_IDR=/m.test(raw)) {
    const next = raw.replace(/^PRODUCT_PRICE_IDR=.*$/m, line);
    fs.writeFileSync(ENV_FILE, next, "utf8");
    return { persisted: true, created: false };
  }

  const suffix = raw.endsWith("\n") || raw.length === 0 ? "" : "\n";
  fs.writeFileSync(ENV_FILE, `${raw}${suffix}${line}\n`, "utf8");
  return { persisted: true, created: false };
}

function setProductPriceIdr(inputPrice) {
  const nextPrice = normalizePriceInput(inputPrice);
  if (!nextPrice) {
    return { ok: false, reason: "INVALID_PRICE" };
  }

  const previousPrice = Number(config.productPriceIdr || 0);
  config.productPriceIdr = nextPrice;

  try {
    const envResult = persistPriceToEnv(nextPrice);
    return {
      ok: true,
      previousPrice,
      nextPrice,
      persisted: Boolean(envResult.persisted)
    };
  } catch (error) {
    return {
      ok: true,
      previousPrice,
      nextPrice,
      persisted: false,
      warning: error && error.message ? error.message : "ENV_WRITE_FAILED"
    };
  }
}

module.exports = {
  normalizePriceInput,
  setProductPriceIdr
};
