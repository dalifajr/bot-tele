const { paths } = require("../config/paths");
const { safeReadJson, writeJson } = require("./jsonFileStore");

const FALLBACK_STATE = {
  userCheckoutQty: {},
  userLastOrderId: {},
  adminInputState: {},
  adminMassState: {}
};

function normalizeSessionState(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    userCheckoutQty: source.userCheckoutQty && typeof source.userCheckoutQty === "object"
      ? source.userCheckoutQty
      : {},
    userLastOrderId: source.userLastOrderId && typeof source.userLastOrderId === "object"
      ? source.userLastOrderId
      : {},
    adminInputState: source.adminInputState && typeof source.adminInputState === "object"
      ? source.adminInputState
      : {},
    adminMassState: source.adminMassState && typeof source.adminMassState === "object"
      ? source.adminMassState
      : {}
  };
}

function loadSessionState() {
  return normalizeSessionState(safeReadJson(paths.sessionState, FALLBACK_STATE));
}

function saveSessionState(state) {
  const normalized = normalizeSessionState(state);
  writeJson(paths.sessionState, normalized);
}

module.exports = {
  loadSessionState,
  saveSessionState
};