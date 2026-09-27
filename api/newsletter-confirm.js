/**
 * Step 2 of double opt-in: verify the signed link, then actually create the
 * Resend contact and apply the topic subscriptions requested in step 1.
 *
 * This is the only place a Resend Contact is created for the newsletter.
 * Nothing here is added on signup — only on confirmation, from data carried
 * inside the token itself, never from a database (there isn't one).
 *
 * API SHAPE — verified live against the real account via the official Resend
 * MCP integration on 2026-09-27, not inferred:
 *   - POST /contacts is a true upsert keyed by email. Confirmed by creating
 *     the same address twice: same contact ID both times, second call's
 *     first_name overwrote the first, status 201 both times. There is no
 *     duplicate-conflict case to handle, so the earlier create-then-fall-
 *     back-to-PATCH logic was solving a problem that does not exist and has
 *     been removed.
 *   - The raw wire field is `first_name` (snake_case) — confirmed by reading
 *     the actual logged request body of a live call, not the MCP tool's own
 *     (camelCase) parameter name, which is the tool's own interface and does
 *     not by itself prove the underlying REST field name.
 *   - Contacts are never required to belong to a Segment/Audience. Confirmed:
 *     the account's one existing Segment ("General") is unrelated to Topics,
 *     and creation with no segmentId works. (Segments matter only for
 *     Broadcasts, which target a segmentId and have no topic-based targeting
 *     at all — a separate concern from this confirmation flow, not handled
 *     here.)
 *   - Topic subscriptions are set with PATCH /contacts/{email}/topics,
 *     confirmed as the real endpoint from two live calls' logged method and
 *     path — not the nested per-topic endpoint this file originally guessed,
 *     which was wrong. One call updates any number of topics at once.
 *     `subscription` is the string enum "opt_in" | "opt_out", never a
 *     boolean. The one thing that could not be fully confirmed: the logged
 *     request body for this specific route rendered as "{}" for both test
 *     calls (apparently a gap in this endpoint's own request logging, not
 *     something within reach to work around), so the exact JSON key wrapping
 *     the topics array is taken from the official tool's documented
 *     parameter shape (`{ topics: [{ id, subscription }] }`) rather than
 *     independently confirmed byte-for-byte.
 *   - Verified live: subscribing a contact to two Topics at once, then
 *     unsubscribing from only one, left the other's subscription untouched —
 *     independent per-topic state, exactly as required.
 *   - Verified live: neither list-contact-topics nor get-contact exposes any
 *     timestamp for when a topic subscription changed — see the project's
 *     final report for the consent-history conclusion this supports.
 */

const token = require("../lib/token.js");

const RESEND_API = "https://api.resend.com";
const REPLY_TO = process.env.NEWSLETTER_REPLY_TO || "louis@easytgroup.com";
const SITE_URL = (process.env.SITE_URL || "https://louisborhani.com").replace(/\/$/, "");

const TOPICS = {
  "business-insights": { id: process.env.NEWSLETTER_TOPIC_BUSINESS || "", label: "Business Insights" },
  "recruitment-career": { id: process.env.NEWSLETTER_TOPIC_RECRUITMENT || "", label: "Recruitment & Career" },
};

function page(status, title, body, trackConfirmed) {
  // A minimal, standalone copy of the site's own first-party event bridge:
  // this page is served from the API route, not from index.html, so it
  // shares no runtime with the main page's script. Same no-cookie,
  // no-third-party, forwards-to-window.va-if-present behaviour, fired only
  // on an actual successful confirmation, never on an error page.
  const tracking = trackConfirmed
    ? `<script>
  window.lbEvents = window.lbEvents || [];
  try {
    var evt = { name: 'newsletter_confirmed', at: Date.now() };
    window.lbEvents.push(evt);
    if (typeof window.va === 'function') { window.va('event', { name: 'newsletter_confirmed' }); }
  } catch (e) {}
</script>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} — Louis Borhani</title>
<style>
  :root{--ink:#14161F;--cream:#F7F4ED;--amber:#BE9B4D;--amber-hi:#D9BE74;--slate:#5A5C63;}
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{background:var(--ink);color:var(--cream);min-height:100%}
  body{font-family:'Inter',system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;padding:24px;line-height:1.6}
  .card{max-width:480px;text-align:center}
  h1{font-family:'Instrument Sans',system-ui,sans-serif;font-weight:700;font-size:clamp(24px,4vw,32px);letter-spacing:-0.02em;margin-bottom:16px}
  p{color:#B6B3AA;font-size:16px}
  a{color:var(--amber-hi);font-weight:600}
</style></head>
<body><div class="card"><h1>${title}</h1>${body}</div>${tracking}</body></html>`;
}

function send(res, status, title, bodyHtml, trackConfirmed) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(status).send(page(status, title, bodyHtml, trackConfirmed));
}

/**
 * POST /contacts unconditionally upserts by email — verified live, not
 * assumed. A repeat confirmation therefore just overwrites the same
 * properties on the same contact; there is no conflict case to fall back
 * from.
 */
async function resendUpsertContact(key, { email, firstName, properties }) {
  const r = await fetch(`${RESEND_API}/contacts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email, first_name: firstName || undefined, unsubscribed: false, properties }),
  });
  return { ok: r.ok, status: r.status };
}

/**
 * One call sets every requested topic's subscription at once — verified live
 * against the real endpoint (see the file-level note for what was and was
 * not independently confirmed about the exact body shape).
 */
async function applyTopicSubscriptions(key, email, topicKeys) {
  const topics = topicKeys
    .map((k) => (TOPICS[k]?.id ? { id: TOPICS[k].id, subscription: "opt_in" } : null))
    .filter(Boolean);
  if (topics.length !== topicKeys.length) {
    console.error(`[newsletter] missing topic id configuration for ${topicKeys.length - topics.length} requested topic(s)`);
  }
  if (!topics.length) return { ok: false, status: 0 };

  const r = await fetch(`${RESEND_API}/contacts/${encodeURIComponent(email)}/topics`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ topics }),
  });
  return { ok: r.ok, status: r.status };
}

module.exports = async (req, res) => {
  const t = (req.query && req.query.t) || "";
  const result = token.verify(t);

  if (!result.ok) {
    const messages = {
      malformed: "That confirmation link isn't valid.",
      tampered: "That confirmation link isn't valid.",
      expired: "That confirmation link has expired. Please sign up again.",
    };
    return send(res, 400, "Link not valid", `<p>${messages[result.reason] || messages.malformed} <a href="${SITE_URL}/#thinking">Back to louisborhani.com</a></p>`);
  }

  const { email, firstName, topics, cv } = result.data;

  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.error("[newsletter] RESEND_API_KEY not set — cannot confirm subscription");
    return send(res, 503, "Not available right now", `<p>Please try again shortly, or email <a href="mailto:${REPLY_TO}">${REPLY_TO}</a> directly.</p>`);
  }

  const properties = {
    signup_source: "louisborhani.com",
    consent_method: "double_opt_in",
    consent_version: cv || "",
    confirmed_at: new Date().toISOString(),
    // Fallback record of intent — see the file-level note. Kept even if the
    // dedicated topic-subscription call below succeeds.
    requested_topics: topics.join(","),
  };

  const contactResult = await resendUpsertContact(key, { email, firstName, properties });
  if (!contactResult.ok) {
    console.error(`[newsletter] contact upsert failed (status ${contactResult.status || "n/a"})`);
    return send(res, 502, "Something went wrong", `<p>We couldn't complete this. Please try again, or email <a href="mailto:${REPLY_TO}">${REPLY_TO}</a> directly.</p>`);
  }

  const topicResult = await applyTopicSubscriptions(key, email, topics);
  if (!topicResult.ok) {
    // The contact exists and requested_topics is recorded either way — this
    // is logged so it can be caught and corrected, not silently lost.
    console.error(`[newsletter] topic subscription call failed (status ${topicResult.status}) — contact created, requested_topics property retained as fallback`);
  }

  const chosen = topics.map((k) => TOPICS[k]?.label || k).join(" and ");
  return send(
    res,
    200,
    "You're confirmed",
    `<p>You're set to receive <strong>${chosen}</strong>${firstName ? `, ${firstName}` : ""}. You can change this any time from the unsubscribe link in any email.</p><p><a href="${SITE_URL}">Back to louisborhani.com</a></p>`,
    true,
  );
};
