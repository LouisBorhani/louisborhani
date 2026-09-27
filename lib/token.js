/**
 * Stateless, signed double-opt-in confirmation tokens.
 *
 * There is no database of pending subscribers. The confirm link itself carries
 * everything needed to complete the signup — email, name, which topics were
 * requested, when it was issued, when it expires — sealed with an HMAC so it
 * cannot be edited in transit. Anyone who legitimately clicks the link
 * already knows what they submitted; the signature exists to stop someone
 * else forging or altering a link, not to hide the payload from its own
 * recipient, so this is signed rather than encrypted.
 *
 * The signing secret itself never appears in the token, in a log, or in any
 * response — only its effect (a valid or invalid signature) is observable.
 */

const crypto = require("node:crypto");

const SECRET = process.env.NEWSLETTER_SIGNING_SECRET || "";

function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(str) {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function sign(payloadB64) {
  return b64url(crypto.createHmac("sha256", SECRET).update(payloadB64).digest());
}

/** True once NEWSLETTER_SIGNING_SECRET is actually set — callers must check
 *  this and fail closed, exactly as the enquiry endpoint fails closed when
 *  RESEND_API_KEY is absent, rather than signing with an empty key. */
function isConfigured() {
  return SECRET.length >= 16;
}

/**
 * @param {{email: string, firstName: string, topics: string[], consentVersion: string}} data
 * @param {number} ttlMs how long the link stays valid
 */
function issue(data, ttlMs) {
  const now = Date.now();
  const payload = {
    email: data.email,
    firstName: data.firstName || "",
    topics: data.topics,
    cv: data.consentVersion,
    iat: now,
    exp: now + ttlMs,
  };
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${payloadB64}.${sign(payloadB64)}`;
}

/**
 * @returns {{ok: true, data: object} | {ok: false, reason: "malformed"|"tampered"|"expired"}}
 */
function verify(token) {
  if (typeof token !== "string" || !token.includes(".")) return { ok: false, reason: "malformed" };
  const [payloadB64, sig] = token.split(".");
  if (!payloadB64 || !sig) return { ok: false, reason: "malformed" };

  const expected = sign(payloadB64);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "tampered" };
  }

  let data;
  try {
    data = JSON.parse(fromB64url(payloadB64).toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof data.exp !== "number" || Date.now() > data.exp) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, data };
}

module.exports = { issue, verify, isConfigured };
