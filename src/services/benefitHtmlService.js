const fs = require("fs");
const { paths } = require("../config/paths");
const { BENEFIT_STATUS } = require("./accountService");

function detectBenefitStatusFromHtml(rawHtml) {
  const html = String(rawHtml || "");

  const hasAwaiting = /Awaiting\s+Benefits/i.test(html);
  const hasCouponApplied = /Coupon\s+applied/i.test(html) && /Progress-item\s+color-bg-success-emphasis/i.test(html);

  if (hasCouponApplied) {
    return BENEFIT_STATUS.APPLIED;
  }

  if (hasAwaiting) {
    return BENEFIT_STATUS.AWAITING;
  }

  return null;
}

function detectBenefitStatusFromSnapshotFile() {
  if (!fs.existsSync(paths.benefitSnapshotHtml)) {
    return null;
  }

  const raw = fs.readFileSync(paths.benefitSnapshotHtml, "utf8");
  return detectBenefitStatusFromHtml(raw);
}

module.exports = {
  detectBenefitStatusFromHtml,
  detectBenefitStatusFromSnapshotFile
};
