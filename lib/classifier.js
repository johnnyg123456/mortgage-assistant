require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { buildSystemPrompt } = require('./style-context');
const { load: loadFeedback } = require('./feedback-handler');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function log(action, detail) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), module: 'classifier', action, ...detail }));
}

// Hard-coded fast-path ignores — no API call needed
const HARD_IGNORE_SUBJECT = [
  /\[mortgage bot\]/i,
  /\[broker assistant\]/i,
  // Self-sent digest / docs-received notifications (bot emails John → John)
  /\[digest\]/i,
  /\[docs received\]/i,
  // Title order bot (Aisha@mytitleco.com) — dry-run / clarification monitoring emails
  /^\[DRY RUN\]\s*Title Agent:/i,
  /^\[ACTION NEEDED\]\s*Clarification ready/i,
  // Loan approval bot (mortgage-bot-push) — Notion condition sync summaries
  /^approvals\s*-\s*\d+\s*(added|cleared)/i,
  /\s-\s*\d+\s+added(?:,\s*\d+\s+cleared)?$/i,
  /synced to notion/i,
  // This bot's own digest email, sent to John's own inbox — was getting re-scanned
  // and drafted a reply to itself on the next run. See [Digest] .../lib/digest-builder.js.
  /^\[Digest\]/i,
  /^\[Docs Received\]/i,
  /^recall:/i,
  /lock confirmation/i,
  /lock update/i,
  /rate lock/i,
  /change of circumstance/i,
  /\bcoc\b.*notice/i,
  /missing items for loan submission/i,
  /loan change request/i,
  /successfully locked/i,
  /lock expiration/i,
  /credentials to access/i,
  /emportal connect/i,
];

const HARD_IGNORE_FROM = [
  /noreply@/i,
  /no-reply@/i,
  /donotreply@/i,
  /notifications?@/i,
  /mailer-daemon/i,
  /postmaster@/i,
];

const HARD_IGNORE_BODY = [
  /^TITLE ORDER AGENT\s*—\s*DRY RUN PREVIEW/im,
  /^Original email:.*\nLoan:.*\n\nSynced to Notion\./ims,
];

// John (or Christy, on her own scan) never needs a drafted reply to mail they sent
// themselves — digests, self-forwards, anything from this bot's own sync/notification
// emails. This is a general safety net independent of exact subject wording.
function isSelfSent(from) {
  const fromLower = (from ?? '').toLowerCase();
  const johnEmail = (process.env.JOHN_EMAIL ?? '').toLowerCase();
  const christyEmail = (process.env.CHRISTINA_EMAIL ?? '').toLowerCase();
  return (johnEmail && fromLower.includes(johnEmail)) || (christyEmail && fromLower.includes(christyEmail));
}

function isFeedbackIgnore(subject, from) {
  try {
    const fb = loadFeedback();
    const fromLower = (from ?? '').toLowerCase();
    const subjLower = (subject ?? '').toLowerCase();
    if ((fb.ignoreSenders ?? []).some(s => fromLower.includes(s.toLowerCase()))) return true;
    if ((fb.ignoreSubjectPatterns ?? []).some(p => subjLower.includes(p.toLowerCase()))) return true;
  } catch { /* non-fatal */ }
  return false;
}

// Never draft a reply to mail John or Christy sent (digests, docs-received, self-forwards).
function isSelfSent(from) {
  const fromLower = (from ?? '').toLowerCase();
  if (!fromLower) return false;
  const own = [process.env.JOHN_EMAIL, process.env.CHRISTINA_EMAIL]
    .filter(Boolean)
    .map(e => e.toLowerCase());
  return own.some(e => fromLower.includes(e));
}

function isHardIgnore(subject, from, body) {
  if (HARD_IGNORE_SUBJECT.some(re => re.test(subject ?? ''))) return true;
  if (HARD_IGNORE_FROM.some(re => re.test(from ?? ''))) return true;
  if (HARD_IGNORE_BODY.some(re => re.test(body ?? ''))) return true;
  if (isSelfSent(from)) return true;
  if (isFeedbackIgnore(subject, from)) return true;
  return false;
}

async function classify(email, styleCtx) {
  const { subject, from, body, messageId } = email;

  if (isSelfSent(from)) {
    log('self-sent-ignore', { messageId, subject, from });
    return { category: 'IGNORE', priority: null, summary: null, draftNeeded: false, reason: 'self-sent' };
  }

  if (isHardIgnore(subject, from, body)) {
    log('hard-ignore', { messageId, subject });
    return { category: 'IGNORE', priority: null, summary: null, draftNeeded: false, reason: 'hard-ignore rule' };
  }

  const systemPrompt = buildSystemPrompt(styleCtx);
  const bodyPreview = (body ?? '').slice(0, 1500);

  const ccLine = email.isCc
    ? `John's role: CC ONLY — he is not the primary recipient. Do NOT set draftNeeded=true. Only flag as URGENT if the issue is severe enough that John needs to be aware even though he wasn't directly addressed.`
    : `John's role: Direct recipient — TO field.`;

  const prompt = `Classify this email for John and decide what action is needed.

From: ${from}
Subject: ${subject}
${ccLine}
Body (first 1500 chars):
${bodyPreview}

Respond with a JSON object (no markdown, no explanation, just raw JSON):
{
  "category": "URGENT" | "RESPOND" | "FYI" | "IGNORE",
  "priority": 1-5 (1=highest, only for URGENT/RESPOND),
  "summary": "one sentence describing what this email is about and what action is needed",
  "draftNeeded": true | false,
  "draftContext": "brief note for what the reply should say (only if draftNeeded=true)",
  "reason": "why you classified it this way"
}

CATEGORY RULES:
- URGENT: Needs John's attention today — closing issues, lender suspensions, expiring docs, client emergencies, CTC requests, anything with a hard deadline
- RESPOND: Needs a reply but not on-fire — client questions, lender follow-ups, LO requests, partner emails
- FYI: Informational only — status updates, confirmations, notifications John should see but not act on
- IGNORE: Automated emails, marketing, lock confirmations, COC notices, bulk lender notifications, anything John would delete without reading
- IGNORE: Automated reminder/renewal/compliance notices from a vendor or portal — e.g. "Reminder: your questionnaire/policy/license is due," insurance or CE renewal reminders, portal notifications referencing a policy/account number. These expect the recipient to go complete something on a website, not reply by email — draftNeeded must always be false for these even if they sound personally addressed or urgent-toned.
- CC RULE: If John is CC'd, draftNeeded must be false. Only use URGENT if the issue is severe. Otherwise FYI or IGNORE.
- IGNORE: Emails from John's own bots — title order agent ([DRY RUN] Title Agent, [ACTION NEEDED] Clarification ready from Aisha@mytitleco.com), loan approval/Notion sync bot (subject ends with "N added" or body says "Synced to Notion."), digests ([Digest]), docs-received notifications ([Docs Received])
- IGNORE: Automated vendor reminder / renewal / questionnaire emails that reference a policy number, account number, or renewal date and do not ask John a direct personal question (E&O, insurance renewals, compliance questionnaires, portal "action required" blasts). Prefer IGNORE over RESPOND for these.`;

  try {
    const response = await anthropic.messages.create({
      model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }]
    });

    const raw = (response.content[0]?.text ?? '').replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    const result = JSON.parse(raw);
    log('classified', { messageId, subject, category: result.category, priority: result.priority });
    return result;
  } catch (err) {
    log('classify-error', { messageId, subject, error: err.message });
    // Default to FYI on error so nothing is accidentally dropped
    return { category: 'FYI', priority: 3, summary: `${subject} (classification failed — review manually)`, draftNeeded: false, reason: 'error' };
  }
}

module.exports = { classify, isHardIgnore, isSelfSent };
