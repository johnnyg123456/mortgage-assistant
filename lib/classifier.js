require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { buildSystemPrompt } = require('./style-context');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function log(action, detail) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), module: 'classifier', action, ...detail }));
}

// Hard-coded fast-path ignores — no API call needed
const HARD_IGNORE_SUBJECT = [
  /\[mortgage bot\]/i,
  /\[broker assistant\]/i,
  // Title order bot (Aisha@mytitleco.com) — dry-run / clarification monitoring emails
  /^\[DRY RUN\]\s*Title Agent:/i,
  /^\[ACTION NEEDED\]\s*Clarification ready/i,
  // Loan approval bot (mortgage-bot-push) — Notion condition sync summaries
  /^approvals\s*-\s*\d+\s*(added|cleared)/i,
  /\s-\s*\d+\s+added(?:,\s*\d+\s+cleared)?$/i,
  /synced to notion/i,
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

function isHardIgnore(subject, from, body) {
  if (HARD_IGNORE_SUBJECT.some(re => re.test(subject ?? ''))) return true;
  if (HARD_IGNORE_FROM.some(re => re.test(from ?? ''))) return true;
  if (HARD_IGNORE_BODY.some(re => re.test(body ?? ''))) return true;
  return false;
}

async function classify(email, styleCtx) {
  const { subject, from, body, messageId } = email;

  if (isHardIgnore(subject, from, body)) {
    log('hard-ignore', { messageId, subject });
    return { category: 'IGNORE', priority: null, summary: null, draftNeeded: false, reason: 'hard-ignore rule' };
  }

  const systemPrompt = buildSystemPrompt(styleCtx);
  const bodyPreview = (body ?? '').slice(0, 1500);

  const prompt = `Classify this email for John and decide what action is needed.

From: ${from}
Subject: ${subject}
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
- IGNORE: Emails from John's own bots — title order agent ([DRY RUN] Title Agent, [ACTION NEEDED] Clarification ready from Aisha@mytitleco.com), loan approval/Notion sync bot (subject ends with "N added" or body says "Synced to Notion.")`;

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

module.exports = { classify, isHardIgnore };
