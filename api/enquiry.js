/**
 * The enquiry endpoint behind every "talk to Louis" call to action.
 *
 * Deliberately small: it validates, it emails, it says what happened. There is
 * no database, no CRM, no queue and no third party holding the message,
 * because an enquiry from an owner-managed business is a note to a person, not
 * a lead record.
 *
 * It fails loudly rather than quietly. If the mail transport is not
 * configured, or the send fails, this returns an error the page can act on and
 * the visitor is handed their own words back in a pre-filled email. An enquiry
 * that disappears silently is worse than no form at all.
 *
 * Configure with RESEND_API_KEY, and optionally ENQUIRY_FROM / ENQUIRY_TO.
 */

const TO = process.env.ENQUIRY_TO || "hello@louisborhani.com";
const FROM = process.env.ENQUIRY_FROM || "Louis Borhani site <enquiries@louisborhani.com>";

const LIMITS = { name: 120, company: 160, situation: 4000, goal: 4000 };

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

function clean(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/\u0000/g, "").trim().slice(0, max);
}

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

  const name = clean(body.name, LIMITS.name);
  const company = clean(body.company, LIMITS.company);
  const situation = clean(body.situation, LIMITS.situation);
  const goal = clean(body.goal, LIMITS.goal);
  const reply = clean(body.reply, 254);

  const missing = [];
  if (!name) missing.push("name");
  if (!situation) missing.push("situation");
  if (!reply || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(reply)) missing.push("reply");
  if (missing.length) {
    return res.status(400).json({ error: "Please complete the required fields.", fields: missing });
  }

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (throttled(ip)) {
    return res.status(429).json({ error: "That has been sent already. Give it a moment." });
  }

  const key = process.env.RESEND_API_KEY;
  if (!key) {
    // Not configured. Say so plainly so the page can fall back rather than
    // pretending the message was delivered.
    console.error("[enquiry] RESEND_API_KEY is not set — enquiry not delivered");
    return res.status(503).json({ error: "Not configured.", code: "not_configured" });
  }

  const text = [
    `From:    ${name}`,
    company ? `Company: ${company}` : null,
    `Reply:   ${reply}`,
    "",
    "What's going on?",
    situation,
    "",
    "What are they trying to achieve?",
    goal || "(not answered)",
  ].filter(Boolean).join("\n");

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM,
        to: [TO],
        reply_to: reply,
        subject: `Enquiry from ${name}${company ? ` at ${company}` : ""}`,
        text,
      }),
    });
    if (!r.ok) {
      console.error("[enquiry] send failed", r.status, (await r.text()).slice(0, 300));
      return res.status(502).json({ error: "Could not send.", code: "send_failed" });
    }
  } catch (e) {
    console.error("[enquiry] send threw", e && e.message);
    return res.status(502).json({ error: "Could not send.", code: "send_failed" });
  }

  return res.status(200).json({ ok: true });
};
