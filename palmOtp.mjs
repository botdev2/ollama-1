import { createHmac, timingSafeEqual } from "node:crypto";

export const OTP_PERIOD = 30;
export const OTP_DIGITS = 6;

function master() {
  return process.env.PALM_ID_OTP_SECRET || process.env.GATE_TOKEN || "palm-id-otp-dev";
}

function otpKey(address) {
  return createHmac("sha256", master())
    .update("palm-id-totp:" + String(address || "").toLowerCase())
    .digest()
    .subarray(0, 20);
}

function toBase32(bytes) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

export function otpSecret(address) {
  return toBase32(otpKey(address));
}

export function otpAuth(address) {
  const wallet = String(address || "").toLowerCase();
  const short = wallet.slice(0, 6) + "..." + wallet.slice(-4);
  const label = encodeURIComponent("PALM ID:" + short);
  const issuer = encodeURIComponent("PALM ID");
  const secret = otpSecret(wallet);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=${OTP_DIGITS}&period=${OTP_PERIOD}`;
}

export function otpStep(now = Date.now()) {
  return Math.floor(now / 1000 / OTP_PERIOD);
}

export function otpCode(address, step) {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(step / 0x100000000), 0);
  buf.writeUInt32BE(step >>> 0, 4);
  const mac = createHmac("sha1", otpKey(address)).update(buf).digest();
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
  const wallet = String(address || "").toLowerCase();
  const step = otpStep(now);
  const remaining = OTP_PERIOD - (Math.floor(now / 1000) % OTP_PERIOD);
  return {
    code: otpCode(wallet, step),
    remaining: remaining === 0 ? OTP_PERIOD : remaining,
    period: OTP_PERIOD,
    digits: OTP_DIGITS,
    algorithm: "SHA1",
    secret: otpSecret(wallet),
    otpauth: otpAuth(wallet),
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
