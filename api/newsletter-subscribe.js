/**
 * Step 1 of double opt-in: validate the signup, then email a confirm link.
 *
 * Nobody is added to Resend here. This only proves the address can receive
 * mail and that a real person clicked to confirm — the actual Contact and
 * Topic subscriptions are created by newsletter-confirm.js, only once that
 * click happens. There is no pending-subscriber database: the confirm link
 * itself is a signed, stateless token (lib/token.js) carrying everything
 * needed to finish the signup.
 *
 * Sends from the marketing subdomain (news.louisborhani.com), kept separate
 * from the transactional enquiry sender (mail.louisborhani.com) so a bad
 * broadcast can never affect the enquiry form's deliverability, and vice
 * versa. This confirmation send itself is plain transactional email — one
 * message to one address, triggered by one action — so it goes through
 * Resend's ordinary emails.send, not the Contacts/Broadcast system.
 */

const { makeThrottle, clean, headerSafe, EMAIL, clientIp } = require("../lib/guard.js");
const token = require("../lib/token.js");

const FROM = process.env.NEWSLETTER_FROM || "";
const REPLY_TO = process.env.NEWSLETTER_REPLY_TO || "louis@easytgroup.com";
const SITE_URL = (process.env.SITE_URL || "https://louisborhani.com").replace(/\/$/, "");

// Consent wording changes over time; bumping this lets a future audit show
// exactly which privacy/consent text someone agreed to, without needing a
// database — it travels inside the signed token and is written to the
// contact's own properties on confirmation.
const CONSENT_VERSION = "2026-09-newsletter-v1";

const TOPICS = {
  "business-insights": { id: process.env.NEWSLETTER_TOPIC_BUSINESS || "", label: "Business Insights" },
  "recruitment-career": { id: process.env.NEWSLETTER_TOPIC_RECRUITMENT || "", label: "Recruitment & Career" },
};

const throttled = makeThrottle(5); // 5 signup attempts per address per minute

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

  // Honeypot — a real visitor never fills a field they cannot see.
  if (clean(body.company, 200)) return res.status(200).json({ ok: true });

  const email = headerSafe(body.email, 254).toLowerCase();
  const firstName = headerSafe(body.firstName, 80);
  const requested = Array.isArray(body.topics) ? body.topics : [];
  const topics = requested.filter((t) => Object.prototype.hasOwnProperty.call(TOPICS, t));

  const missing = [];
  if (!email || !EMAIL.test(email)) missing.push("email");
  if (topics.length === 0) missing.push("topics");
  if (missing.length) {
    return res.status(400).json({ error: "Please complete the required fields.", fields: missing });
  }

  const ip = clientIp(req);
  if (throttled(ip)) {
    return res.status(429).json({ error: "That has been sent already. Give it a moment." });
  }

  if (!token.isConfigured()) {
    console.error("[newsletter] NEWSLETTER_SIGNING_SECRET is not set — cannot issue a confirm link");
    return res.status(503).json({ error: "Not configured.", code: "not_configured" });
  }
  const key = process.env.RESEND_API_KEY;
  if (!key || !FROM) {
    const absent = [!key && "RESEND_API_KEY", !FROM && "NEWSLETTER_FROM"].filter(Boolean);
    console.error(`[newsletter] not configured: ${absent.join(", ")} — confirmation not sent`);
    return res.status(503).json({ error: "Not configured.", code: "not_configured" });
  }

  const confirmToken = token.issue(
    { email, firstName, topics, consentVersion: CONSENT_VERSION },
    48 * 60 * 60 * 1000, // 48 hours
  );
  const confirmUrl = `${SITE_URL}/api/newsletter-confirm?t=${encodeURIComponent(confirmToken)}`;

  const chosenLabels = topics.map((t) => TOPICS[t].label);
  const text = [
    firstName ? `Hi ${firstName},` : "Hi,",
    "",
    "You asked to receive:",
    ...chosenLabels.map((l) => `- ${l}`),
    "",
    "Confirm my subscription:",
    confirmUrl,
    "",
    "If that link doesn't work, paste this into your browser:",
    confirmUrl,
    "",
    "If you didn't ask for this, ignore this email and nothing will be sent.",
    "This link expires in 48 hours.",
  ].join("\n");

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM,
        to: [email],
        reply_to: REPLY_TO,
        subject: "Confirm your Louis Borhani emails",
        text,
      }),
    });
    if (!r.ok) {
      console.error(`[newsletter] confirm-email send rejected (status ${r.status})`);
      return res.status(502).json({ error: "Could not send.", code: "send_failed" });
    }
  } catch {
    console.error("[newsletter] confirm-email send threw before completing");
    return res.status(502).json({ error: "Could not send.", code: "send_failed" });
  }

  return res.status(200).json({ ok: true });
};
