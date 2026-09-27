/**
 * Shared request-guarding primitives, factored out of the enquiry endpoint so
 * the newsletter endpoints get the exact same proven behaviour rather than a
 * second, slightly-different copy of the same logic.
 *
 * Deliberately outside api/ — Vercel's zero-config routing turns every file
 * under api/ into its own function, so shared code has to live somewhere
 * that isn't auto-routed. A plain top-level lib/ directory is unambiguous.
 */

/**
 * Best-effort per-key throttle: at most windowMax hits per key per window.
 * Serverless instances are not shared, so this thins repeat submissions from
 * one warm instance rather than promising a global rate limit — enough to
 * blunt accidental double-sends and casual abuse.
 */
function makeThrottle(windowMax, windowMs = 60000) {
  const hits = new Map();
  return function throttled(key) {
    const now = Date.now();
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 500) {
      for (const [k, times] of hits) {
        if (!times.length || now - times[times.length - 1] >= windowMs) hits.delete(k);
      }
    }
    return recent.length > windowMax;
  };
}

/** Body text. Newlines are meaningful, other control characters are not. */
function clean(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, max);
}

/**
 * Anything that reaches a header (subject, From, Reply-To) must not carry a
 * line break — a CR/LF smuggled in is header injection. Collapse whitespace
 * runs to a single space rather than merely stripping newlines.
 */
function headerSafe(value, max) {
  return clean(value, max).replace(/\s+/g, " ").trim();
}

const EMAIL = /^[^\s@<>,;:"'\\]+@[^\s@<>,;:"'\\]+\.[^\s@<>,;:"'\\]+$/;

function clientIp(req) {
  return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
}

module.exports = { makeThrottle, clean, headerSafe, EMAIL, clientIp };
