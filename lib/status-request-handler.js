require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { buildRawMessage, getHeader } = require('./gmail-client');
const { findLoanByNumberOrBorrower, getLoanNumberFromPage } = require('./loan-service');
const { getOpenConditionsForLoan } = require('./condition-parser');
const { load: loadStyleCtx, buildSystemPrompt } = require('./style-context');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const DRY_RUN = process.env.DRY_RUN === 'true';
const ENABLED = process.env.STATUS_REQUEST_ENABLED !== 'false';

function log(action, detail) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), module: 'status-request-handler', action, ...detail }));
}

const INTERNAL_DOMAIN = '@libertygroupfunding.com';

// Loan officers who don't use the company domain (personal Gmail/AOL/etc).
// Comma-separated list of exact email addresses — add to this env var as the
// team changes rather than editing code. Example:
//   STATUS_REQUEST_ALLOWED_SENDERS=adigalrealtor@gmail.com,ysisson@aol.com
const ALLOWED_EXTERNAL_SENDERS = (process.env.STATUS_REQUEST_ALLOWED_SENDERS || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

// Internal team member (LO, etc.) asking — not John, Christy, or the feedback bot themselves.
// Covers two cases: (1) anyone on the company domain (e.g. Gil), and (2) LOs who use a
// personal email address and are explicitly allow-listed via STATUS_REQUEST_ALLOWED_SENDERS
// (e.g. Adi at a Gmail address, Yaeli at an AOL address).
function isInternalTeamSender(from) {
  const email = (from ?? '').toLowerCase();
  const emailAddr = (email.match(/<(.+)>/)?.[1] ?? email).trim();

  if (email.includes(INTERNAL_DOMAIN)) {
    const excluded = [process.env.JOHN_EMAIL, process.env.CHRISTINA_EMAIL, process.env.EBOT_EMAIL]
      .filter(Boolean).map(e => e.toLowerCase());
    return !excluded.some(e => email.includes(e));
  }

  return ALLOWED_EXTERNAL_SENDERS.includes(emailAddr);
}

// Fast keyword pre-filter so most internal mail skips the AI call entirely.
const STATUS_KEYWORDS = [
  'status', 'update on', 'any update', 'where are we', 'where\'s this', 'wheres this',
  'what\'s outstanding', 'whats outstanding', 'what\'s needed', 'whats needed',
  'what\'s left', 'whats left', 'conditions left', 'what is needed', 'what is left',
  'clear to close', 'ctc status', 'how\'s this loan', 'hows this loan',
  'checking on', 'any movement', 'progress on', 'any news on'
];

function looksLikeStatusRequest(subject, body) {
  const text = `${subject ?? ''} ${body ?? ''}`.toLowerCase();
  return STATUS_KEYWORDS.some(k => text.includes(k));
}

async function extractLoanIntent(email) {
  const prompt = `An internal loan officer at a mortgage brokerage is emailing the processor asking about a loan's status.

From: ${email.from}
Subject: ${email.subject}
Body (first 1000 chars):
${(email.body ?? '').slice(0, 1000)}

Determine:
1. Is this actually asking for a loan status / outstanding-conditions update? (not just chatting, not about something unrelated)
2. What loan is this about — extract a loan number if present, and/or the borrower's name if present.

Respond with ONLY raw JSON, no markdown:
{
  "isStatusRequest": true | false,
  "loanNumber": "string or null",
  "borrowerName": "string or null"
}`;

  const response = await anthropic.messages.create({
    model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    messages: [{ role: 'user', content: prompt }]
  });
  const raw = (response.content[0]?.text ?? '').replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
  try { return JSON.parse(raw); }
  catch (err) {
    log('intent-parse-error', { error: err.message, raw: raw.slice(0, 200) });
    return { isStatusRequest: false, loanNumber: null, borrowerName: null };
  }
}

// Strip leading lender condition codes like "165 | " before handing to the model —
// keeps the raw substance, lets the model do the plain-English rewrite.
function stripConditionCode(title) {
  return (title ?? '').replace(/^[A-Za-z0-9]{1,6}\s*\|\s*/, '').trim();
}

async function draftStatusReply({ email, loan, conditions }) {
  const styleCtx = loadStyleCtx();
  const systemPrompt = buildSystemPrompt(styleCtx, email) +
    `\n\nNOTE: You are drafting this one on behalf of Christy, the processor — not John. Sign off as Christy, not John. Same brief, direct tone otherwise.`;

  const loanName = loan.properties?.['Borrower Name']?.title?.[0]?.plain_text ?? email.borrowerName ?? 'this loan';
  const loanNumber = getLoanNumberFromPage(loan);

  const conditionLines = conditions.length
    ? conditions.map(c => {
        const title = c.properties?.Condition?.title?.[0]?.plain_text ?? '';
        const status = c.properties?.Status?.select?.name ?? 'Open';
        return `- ${stripConditionCode(title)} (status: ${status})`;
      }).join('\n')
    : null;

  const prompt = `Write a reply to an internal loan officer asking for a status update on loan: ${loanName}${loanNumber ? ` (#${loanNumber})` : ''}.

${conditionLines
  ? `Outstanding items pulled from our tracker (raw lender language — translate into plain English an LO can skim in 5 seconds):\n${conditionLines}`
  : `There are no open conditions in the tracker right now for this loan — everything currently tracked is cleared or waived.`}

Write ONLY the body of the reply — no subject line, no preamble like "Here is a draft". List outstanding items as a short bulleted list in plain English, stripped of lender jargon and internal codes. Keep it brief — this is an internal update, not a client letter.`;

  const response = await anthropic.messages.create({
    model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
    max_tokens: 600,
    system: systemPrompt,
    messages: [{ role: 'user', content: prompt }]
  });

  return response.content[0]?.text ?? '';
}

async function createDraftInAccount(account, email, draftBody) {
  const gmail = account.gmail;

  let messageId = '';
  let threadId = email.threadId;
  try {
    const meta = await gmail.users.messages.get({
      userId: 'me', id: email.messageId, format: 'metadata', metadataHeaders: ['Message-ID', 'Subject']
    });
    const headers = meta.data.payload?.headers ?? [];
    messageId = getHeader(headers, 'Message-ID');
    threadId = threadId || meta.data.threadId;
  } catch { /* non-fatal */ }

  const replySubject = (email.subject ?? '').toLowerCase().startsWith('re:')
    ? email.subject
    : `Re: ${email.subject}`;

  const raw = buildRawMessage({
    from: account.email,
    to: email.from,
    subject: replySubject,
    body: draftBody,
    inReplyTo: messageId || undefined,
    references: messageId || undefined
  });

  const result = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: { message: { raw, threadId: threadId || undefined } }
  });

  return result.data.id;
}

// Returns { handled: boolean, draftId?: string|null }. handled=true tells the caller
// this message was fully processed here and should not fall through to the normal
// classify/digest pipeline.
async function handle(account, email) {
  if (!ENABLED) return { handled: false };
  if (!isInternalTeamSender(email.from)) return { handled: false };
  if (!looksLikeStatusRequest(email.subject, email.body)) return { handled: false };

  const intent = await extractLoanIntent(email);
  if (!intent.isStatusRequest) {
    log('not-status-request', { from: email.from, subject: email.subject });
    return { handled: false };
  }
  if (!intent.loanNumber && !intent.borrowerName) {
    log('no-loan-identifier', { from: email.from, subject: email.subject });
    return { handled: false };
  }

  const loan = await findLoanByNumberOrBorrower(intent.loanNumber, intent.borrowerName);
  if (!loan) {
    log('loan-not-found', { from: email.from, loanNumber: intent.loanNumber, borrowerName: intent.borrowerName });
    return { handled: false };
  }

  const conditions = await getOpenConditionsForLoan(loan.id);
  const draftBody = await draftStatusReply({
    email: { ...email, borrowerName: intent.borrowerName },
    loan,
    conditions
  });

  if (DRY_RUN) {
    log('dry-run', { from: email.from, loan: getLoanNumberFromPage(loan) });
    return { handled: true, draftId: null };
  }

  const draftId = await createDraftInAccount(account, email, draftBody);
  log('draft-created', {
    from: email.from,
    loan: getLoanNumberFromPage(loan),
    draftId,
    openConditions: conditions.length
  });
  return { handled: true, draftId };
}

module.exports = { handle, isInternalTeamSender, looksLikeStatusRequest };
