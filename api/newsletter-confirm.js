/**
 * Step 2 of double opt-in: verify the signed link, then actually create the
 * Resend contact and apply the topic subscriptions requested in step 1.
 *
 * This is the only place a Resend Contact is created for the newsletter.
 * Nothing here is added on signup — only on confirmation, from data carried
 * inside the token itself, never from a database (there isn't one).
 *
 * NOTE ON VERIFIED-VS-UNVERIFIED API SHAPE — read before changing this file:
 * The contact create/update call below (resendUpsertContact) is verified only
 * to the extent published third-party documentation could confirm from this
 * environment (direct access to api.resend.com and resend.com's own docs is
 * blocked here). The exact JSON field names for applying a Topic subscription
 * to a contact were NOT independently confirmed against a live call before
 * this was written. It is deliberately isolated in one small function
 * (applyTopicSubscriptions) so it can be corrected without touching anything
 * else, and every requested topic is also written to a plain contact
 * property (below) as a fallback — so even if that one call's shape needs
 * fixing after the first real test, the record of what was actually
 * requested and when is never lost.
 */

const token = require("../lib/token.js");

const RESEND_API = "https://api.resend.com";
const REPLY_TO = process.env.NEWSLETTER_REPLY_TO || "louis@easytgroup.com";
const SITE_URL = (process.env.SITE_URL || "https://louisborhani.com").replace(/\/$/, "");
// Optional: only needed if this Resend account still requires contacts to
// belong to an Audience/Segment. Left unset, the code calls the newer global
// Contacts endpoint. Set this only if the global endpoint is confirmed to
// reject creation without one.
const AUDIENCE_ID = process.env.NEWSLETTER_AUDIENCE_ID || "";

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
 * Create-or-update by email. Tries create first; if the account rejects it
 * as a duplicate, falls back to an update call keyed by email. This makes a
 * repeat confirmation (someone clicking an old link twice, or re-confirming
 * after unsubscribing) safe either way, regardless of which behaviour this
 * Resend account's Contacts API actually has for an existing address.
 */
async function resendUpsertContact(key, { email, firstName, properties }) {
  const base = AUDIENCE_ID ? `${RESEND_API}/audiences/${AUDIENCE_ID}/contacts` : `${RESEND_API}/contacts`;
  const body = JSON.stringify({ email, first_name: firstName || undefined, unsubscribed: false, properties });

  let r = await fetch(base, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body,
  });
  if (r.ok) return { ok: true };

  // Duplicate-address case: fall back to an update. Not logging the response
  // body — it may echo the request back, and we never log email addresses
  // beyond what's needed to see *that* something failed.
  r = await fetch(`${base}/${encodeURIComponent(email)}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body,
  });
  return { ok: r.ok, status: r.status };
}

/** Isolated on purpose — see the file-level note on unverified API shape. */
async function applyTopicSubscriptions(key, email, topicKeys) {
  const results = await Promise.allSettled(
    topicKeys.map((k) => {
      const topicId = TOPICS[k]?.id;
      if (!topicId) return Promise.reject(new Error(`no topic id configured for ${k}`));
      return fetch(`${RESEND_API}/contacts/${encodeURIComponent(email)}/topics/${encodeURIComponent(topicId)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ subscribed: true }),
      }).then((r) => ({ topic: k, ok: r.ok, status: r.status }));
    }),
  );
  return results.map((r) => (r.status === "fulfilled" ? r.value : { ok: false, error: String(r.reason) }));
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

  const topicResults = await applyTopicSubscriptions(key, email, topics);
  const topicFailures = topicResults.filter((r) => !r.ok);
  if (topicFailures.length) {
    // The contact exists and requested_topics is recorded either way — this
    // is logged so it can be caught and corrected, not silently lost.
    console.error(`[newsletter] topic subscription call failed for ${topicFailures.length}/${topics.length} topic(s) — contact created, requested_topics property retained as fallback`);
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
