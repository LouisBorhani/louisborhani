/**
 * The enquiry endpoint behind every "talk to Louis" call to action.
 *
 * Deliberately small: it validates, it emails, it says what happened. There is
 * no database, no CRM, no queue and no third party holding the message,
 * because an enquiry from an owner-managed business is a note to a person, not
 * a lead record.
 *
 * Mail goes through Resend, the same account Clarity already uses. This calls
 * the REST API with fetch rather than the SDK Clarity uses: this project is a
 * static site with no package.json, and adding a dependency to send one plain
 * text email would turn it into a build. The request shape is the same.
 *
 * It fails loudly rather than quietly. If the transport is not configured, or
 * the send fails, this returns an error the page can act on and the visitor is
 * handed their own words back in a pre-filled email. An enquiry that
 * disappears silently is worse than no form at all.
 *
 * Secrets stay here. RESEND_API_KEY is read server-side only, is never
 * returned in a response and is never logged — including on the failure paths,
 * which log a status code and our own message rather than echoing the
 * provider's response body.
 */

const TO = process.env.ENQUIRY_TO || "";
const FROM = process.env.ENQUIRY_FROM || "";

const LIMITS = { name: 120, company: 160, situation: 4000, goal: 4000, reply: 254 };

/** Best-effort throttle. Serverless instances are not shared, so this thins
 *  repeat submissions from one warm instance rather than promising a global
 *  rate limit. It is here to blunt accidental double-sends and casual abuse. */
const seen = new Map();
function throttled(key) {
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > 60000) seen.delete(k);
  const hits = [...seen.keys()].filter((k) => k.startsWith(key + "|")).length;
  seen.set(`${key}|${now}`, now);
  return hits >= 5;
}

/** Body text. Newlines are meaningful here, other control characters are not. */
function clean(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, max);
}

/**
 * Anything that ends up in a header — the subject, the Reply-To — must not be
 * able to carry a line break. A CR or LF smuggled into one of these is how a
 * visitor would otherwise inject their own headers and turn this form into an
 * open relay. Collapse all whitespace runs to a single space.
 */
function headerSafe(value, max) {
  return clean(value, max).replace(/\s+/g, " ").trim();
}

const EMAIL = /^[^\s@<>,;:"'\\]+@[^\s@<>,;:"'\\]+\.[^\s@<>,;:"'\\]+$/;

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  if (!body || typeof body !== "object") {
    return res.status(400).json({ error: "Invalid request." });
  }

  // Honeypot: a real person never fills a field they cannot see. Answer 200 so
  // a bot learns nothing from the response.
  if (clean(body.website, 200)) return res.status(200).json({ ok: true });

  const name = headerSafe(body.name, LIMITS.name);
  const company = headerSafe(body.company, LIMITS.company);
  const reply = headerSafe(body.reply, LIMITS.reply);
  const situation = clean(body.situation, LIMITS.situation);
  const goal = clean(body.goal, LIMITS.goal);

  const missing = [];
  if (!name) missing.push("name");
  if (!reply || !EMAIL.test(reply)) missing.push("reply");
  if (!situation) missing.push("situation");
  if (missing.length) {
    return res.status(400).json({ error: "Please complete the required fields.", fields: missing });
  }

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (throttled(ip)) {
    return res.status(429).json({ error: "That has been sent already. Give it a moment." });
  }

  const key = process.env.RESEND_API_KEY;
  if (!key || !TO || !FROM) {
    // Not configured. Say so plainly so the page can fall back rather than
    // pretending the message was delivered. Names only, never values.
    const absent = [!key && "RESEND_API_KEY", !TO && "ENQUIRY_TO", !FROM && "ENQUIRY_FROM"].filter(Boolean);
    console.error(`[enquiry] not configured: ${absent.join(", ")} — enquiry not delivered`);
    return res.status(503).json({ error: "Not configured.", code: "not_configured" });
  }

  const text = [
    `Name:      ${name}`,
    `Company:   ${company || "—"}`,
    `Email:     ${reply}`,
    "",
    "What's going on?",
    situation,
    "",
    "What are you trying to achieve?",
    goal || "—",
    "",
    `Submitted: ${new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC")}`,
    "Source:    louisborhani.com",
  ].join("\n");

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM,
        to: [TO],
        // So Louis can simply hit reply. The visitor is never the From address:
        // that would fail SPF/DKIM for their domain and land this in spam.
        reply_to: reply,
        subject: `New website enquiry — ${company || name}`,
        // Plain text only. No html field is ever sent, so nothing a visitor
        // types can render as markup in the inbox.
        text,
      }),
    });
    if (!r.ok) {
      console.error(`[enquiry] provider rejected the send (status ${r.status})`);
      return res.status(502).json({ error: "Could not send.", code: "send_failed" });
    }
  } catch {
    console.error("[enquiry] send threw before completing");
    return res.status(502).json({ error: "Could not send.", code: "send_failed" });
  }

  return res.status(200).json({ ok: true });
};
