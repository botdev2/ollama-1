import { createHmac, timingSafeEqual } from "node:crypto";

export const OTP_PERIOD = 20;
export const OTP_DIGITS = 6;

function secret() {
  return process.env.PALM_ID_OTP_SECRET || process.env.GATE_TOKEN || "palm-id-otp-dev";
}

export function otpStep(now = Date.now()) {
  return Math.floor(now / 1000 / OTP_PERIOD);
}

export function otpCode(address, step) {
  const mac = createHmac("sha256", secret())
    .update("palm-id:" + String(address || "").toLowerCase() + ":" + String(step))
    .digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin =
    ((mac[offset] & 0x7f) << 24) |
    (mac[offset + 1] << 16) |
    (mac[offset + 2] << 8) |
    mac[offset + 3];
  const n = (bin >>> 0) % 10 ** OTP_DIGITS;
  return String(n).padStart(OTP_DIGITS, "0");
}

export function otpNow(address, now = Date.now()) {
  const step = otpStep(now);
  const remaining = OTP_PERIOD - (Math.floor(now / 1000) % OTP_PERIOD);
  return {
    code: otpCode(address, step),
    remaining: remaining === 0 ? OTP_PERIOD : remaining,
    period: OTP_PERIOD,
    digits: OTP_DIGITS,
  };
}

export function otpCheck(address, code) {
  const want = String(code || "").replace(/\s/g, "");
  if (!new RegExp("^\\d{" + OTP_DIGITS + "}$").test(want)) return false;
  const step = otpStep();
  const got = Buffer.from(want);
  for (const n of [step, step - 1]) {
    const sample = Buffer.from(otpCode(address, n));
    if (got.length === sample.length && timingSafeEqual(got, sample)) return true;
  }
  return false;
}
