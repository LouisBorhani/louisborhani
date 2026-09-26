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

const LIMITS = { name: 120, company: 160, situation: 4000, goal: 4000, reply: 254, help: 40 };

/**
 * One optional document, carried as base64 inside the JSON body rather than
 * multipart, so the endpoint stays dependency-free on a project with no
 * package.json. 3MB raw is the ceiling: base64 inflates by a third, and the
 * platform caps a serverless request body at 4.5MB.
 *
 * Nothing is stored. The bytes live in memory for the length of one request,
 * go out as a Resend attachment, and are gone. There is no bucket, no
 * database and no path exposed to anyone.
 */
const MAX_FILE_BYTES = 3 * 1024 * 1024;

/* Extension must agree with the leading bytes. A DOCX is a zip, so PK alone
 * cannot separate it from an archive — the extension has to carry that, and
 * .zip is simply not in the list. */
const FILE_TYPES = {
  pdf:  { mime: 'application/pdf', magic: [[0x25, 0x50, 0x44, 0x46]] },
  doc:  { mime: 'application/msword', magic: [[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]] },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          magic: [[0x50, 0x4B, 0x03, 0x04], [0x50, 0x4B, 0x05, 0x06], [0x50, 0x4B, 0x07, 0x08]] },
};

/**
 * Strip every path component and anything that is not plainly a filename.
 *
 * Denies rather than allowlists so an accented name survives intact — a CV
 * called "résumé.pdf" should not arrive as "rsum.pdf". What is removed is
 * what is actually dangerous: path separators, control characters, and the
 * characters that break filenames or headers.
 */
function safeName(raw, ext) {
  const base = String(raw || '').split(/[\\/]/).pop().replace(/\.[^.]*$/, '');
  const clean = base
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[<>:"|?*\\/]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return (clean || 'attachment') + '.' + ext;
}

/**
 * Returns { attachment, name } on success, or { error, status } to refuse.
 * Refuses on any disagreement between what was claimed and what arrived.
 */
function checkFile(rawName, rawData) {
  const ext = String(rawName || '').split('.').pop().toLowerCase();
  const spec = FILE_TYPES[ext];
  if (!spec) return { error: 'Unsupported file type.', status: 415 };

  if (typeof rawData !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(rawData)) {
    return { error: 'Invalid attachment.', status: 400 };
  }
  let buf;
  try { buf = Buffer.from(rawData, 'base64'); } catch { return { error: 'Invalid attachment.', status: 400 }; }

  if (!buf.length) return { error: 'Attachment is empty.', status: 400 };
  if (buf.length > MAX_FILE_BYTES) return { error: 'Attachment is too large.', status: 413 };

  const matches = spec.magic.some((sig) => sig.every((byte, i) => buf[i] === byte));
  if (!matches) return { error: 'That file does not look like a ' + ext.toUpperCase() + '.', status: 415 };

  return { attachment: { filename: safeName(rawName, ext), content: rawData, contentType: spec.mime },
           name: safeName(rawName, ext) };
}

/**
 * Best-effort throttle: at most WINDOW_MAX submissions per address per minute.
 *
 * Serverless instances are not shared, so this thins repeat submissions from
 * one warm instance rather than promising a global rate limit. It is here to
 * blunt accidental double-sends and casual abuse.
 *
 * Timestamps are kept per key in a list. An earlier version used the instant
 * as part of the map key, which meant two requests in the same millisecond
 * overwrote each other and a burst never counted past one or two.
 */
const WINDOW_MS = 60000;
const WINDOW_MAX = 5;
const hits = new Map();

function throttled(key) {
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(key, recent);

  // A long-lived instance must not accumulate a row per address forever.
  if (hits.size > 500) {
    for (const [k, times] of hits) {
      if (!times.length || now - times[times.length - 1] >= WINDOW_MS) hits.delete(k);
    }
  }
  return recent.length > WINDOW_MAX;
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
  const help = headerSafe(body.help, LIMITS.help);

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

  // Validate the attachment before doing anything else with it.
  let attachment = null;
  let attachmentName = "";
  if (body.fileData || body.fileName) {
    const checked = checkFile(body.fileName, body.fileData);
    if (checked.error) return res.status(checked.status).json({ error: checked.error });
    attachment = checked.attachment;
    attachmentName = checked.name;
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
    `Name:       ${name}`,
    `Company:    ${company || "—"}`,
    `Email:      ${reply}`,
    `Help type:  ${help || "—"}`,
    "",
    "Tell me a little more",
    situation,
    "",
    "What would a useful outcome look like?",
    goal || "—",
    "",
    `Attachment: ${attachmentName || "none"}`,
    `Submitted:  ${new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC")}`,
    "Source:     louisborhani.com",
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
        ...(attachment ? { attachments: [attachment] } : {}),
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
