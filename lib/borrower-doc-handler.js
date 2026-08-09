require('dotenv').config();
const pdfParse = require('pdf-parse');
const Anthropic = require('@anthropic-ai/sdk');
const { findLoanByNumberOrBorrower, getLoanNumberFromPage } = require('./loan-service');
const { getOpenConditionsForLoan } = require('./condition-parser');
const { sendToBothInboxes } = require('./send-email');
const {
  isBrokerEmail,
  isKnownLenderEmployeeEmail,
  isTitleOrClosingEmail
} = require('./email-parties');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const DRY_RUN = process.env.DRY_RUN === 'true';
// Opt-out flag — on by default so docs get tracked once deployed; set false to disable.
const ENABLED = process.env.BORROWER_DOC_TRACKING_ENABLED !== 'false';

// Same allow-list as status-request-handler — LOs on personal Gmail/AOL/etc.
const ALLOWED_EXTERNAL_LOS = (process.env.STATUS_REQUEST_ALLOWED_SENDERS || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

const BULK_SENDER_RE = /noreply@|no-reply@|donotreply@|notifications?@|mailer-daemon|postmaster@/i;
const MAX_PDFS = 8;
const MAX_PDF_CHARS = 2500;

function log(action, detail) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), module: 'borrower-doc-handler', action, ...detail }));
}

function extractEmailAddr(from) {
  const raw = (from ?? '').toLowerCase();
  return (raw.match(/<([^>]+)>/)?.[1] ?? raw).trim();
}

function isLoForward(from) {
  if (isBrokerEmail(from)) return true;
  return ALLOWED_EXTERNAL_LOS.includes(extractEmailAddr(from));
}

// Borrower (external) or LO forwarding borrower docs — not lenders, title, or bulk senders.
function isEligibleDocSender(from, subject, body) {
  const fromVal = from ?? '';
  if (!fromVal || BULK_SENDER_RE.test(fromVal)) return false;
  if (isTitleOrClosingEmail(fromVal, subject, body)) return false;
  if (isKnownLenderEmployeeEmail(fromVal, body)) return false;

  // LO / internal forward (company domain or allow-listed personal LO addresses),
  // including John/Christy forwarding docs into their own inbox.
  if (isLoForward(fromVal)) return true;

  // External personal address → treat as borrower-submitted.
  const addr = extractEmailAddr(fromVal);
  return Boolean(addr && addr.includes('@') && !addr.endsWith('@libertygroupfunding.com'));
}

function stripConditionCode(title) {
  return (title ?? '').replace(/^[A-Za-z0-9]{1,6}\s*\|\s*/, '').trim();
}

function conditionTitle(cond) {
  return cond.properties?.Condition?.title?.[0]?.plain_text ?? '';
}

async function extractLoanIntent(email, pdfFilenames) {
  const prompt = `A mortgage processor received an email that may contain borrower documents (W2s, paystubs, bank statements, IDs, etc.) either from the borrower or from a loan officer forwarding them.

From: ${email.from}
Subject: ${email.subject}
Attachments: ${(pdfFilenames ?? []).join(', ') || '(none)'}
Body (first 1200 chars):
${(email.body ?? '').slice(0, 1200)}

Determine:
1. Is this actually borrower document delivery (not an approval letter, not a lender condition list, not marketing, not a random PDF)?
2. What loan is this about — loan number and/or borrower name if present in the subject, body, or filenames.

Respond with ONLY raw JSON, no markdown:
{
  "isBorrowerDocs": true | false,
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
    return { isBorrowerDocs: false, loanNumber: null, borrowerName: null };
  }
}

async function extractPdfText(buffer) {
  try {
    const result = await pdfParse(buffer);
    return (result.text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_PDF_CHARS);
  } catch (err) {
    log('pdf-parse-error', { error: err.message });
    return '';
  }
}

async function classifyDocuments({ email, loanName, loanNumber, conditions, docs }) {
  const conditionLines = conditions.length
    ? conditions.map((c, i) => `${i + 1}. ${stripConditionCode(conditionTitle(c))}`).join('\n')
    : '(no open conditions in Notion)';

  const docBlocks = docs.map((d, i) => (
    `--- FILE ${i + 1}: ${d.filename} ---\n${d.text || '(could not extract text — classify from filename only)'}`
  )).join('\n\n');

  const prompt = `You are helping a mortgage processor match newly received borrower PDF documents against open loan conditions.

Loan: ${loanName}${loanNumber ? ` (#${loanNumber})` : ''}
Original email from: ${email.from}
Subject: ${email.subject}

OPEN CONDITIONS:
${conditionLines}

DOCUMENTS:
${docBlocks}

For each file, identify what the document likely is and which open condition(s) it might satisfy (if any). Be conservative — only suggest a match when the file content/filename clearly relates. Prefer "none" over a stretch.

Respond with ONLY raw JSON, no markdown:
{
  "files": [
    {
      "filename": "exact filename",
      "likelyType": "short label e.g. 2024 W2 / Bank statement / Driver license",
      "matchedConditions": ["exact open-condition text from the list, or empty"],
      "confidence": "high" | "medium" | "low",
      "notes": "one short sentence"
    }
  ],
  "unmatchedConditions": ["open conditions with no suggested file"]
}`;

  const response = await anthropic.messages.create({
    model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
    max_tokens: 1200,
    messages: [{ role: 'user', content: prompt }]
  });
  const raw = (response.content[0]?.text ?? '').replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
  try { return JSON.parse(raw); }
  catch (err) {
    log('classify-parse-error', { error: err.message, raw: raw.slice(0, 300) });
    return {
      files: docs.map(d => ({
        filename: d.filename,
        likelyType: 'Unknown (classification failed)',
        matchedConditions: [],
        confidence: 'low',
        notes: 'Review manually'
      })),
      unmatchedConditions: conditions.map(c => stripConditionCode(conditionTitle(c))).filter(Boolean)
    };
  }
}

function buildSummaryEmail({ loanName, loanNumber, email, classification, openCount }) {
  const fileLines = (classification.files ?? []).map((f, i) => {
    const matches = (f.matchedConditions ?? []).length
      ? f.matchedConditions.map(m => `     • ${m}`).join('\n')
      : '     • (no clear open-condition match)';
    return (
      `${i + 1}. ${f.filename}\n` +
      `   Likely: ${f.likelyType || 'Unknown'} (${f.confidence || 'low'} confidence)\n` +
      `   May satisfy:\n${matches}\n` +
      `   Note: ${f.notes || '—'}`
    );
  }).join('\n\n');

  const unmatched = (classification.unmatchedConditions ?? []);
  const unmatchedBlock = unmatched.length
    ? unmatched.map(c => `  - ${c}`).join('\n')
    : '  (all open conditions have a suggested match, or none were open)';

  return (
    `Borrower documents were received and matched against open Notion conditions for review.\n` +
    `Nothing was uploaded to Notion and no conditions were changed — please confirm.\n\n` +
    `Loan: ${loanName}${loanNumber ? ` (#${loanNumber})` : ''}\n` +
    `From: ${email.from}\n` +
    `Subject: ${email.subject}\n` +
    `Open conditions checked: ${openCount}\n\n` +
    `FILES:\n${fileLines || '(none)'}\n\n` +
    `OPEN CONDITIONS WITH NO SUGGESTED FILE:\n${unmatchedBlock}\n\n` +
    `Next step: Christy — confirm the matches, upload to the lender / clear conditions in Notion as appropriate.`
  );
}

/**
 * @param {object} account - gmail account from getClients()
 * @param {object} email - { messageId, threadId, subject, from, body }
 * @param {Array<{filename: string, buffer: Buffer}>} pdfs
 * @returns {{ handled: boolean, reason?: string }}
 */
async function handle(account, email, pdfs = []) {
  if (!ENABLED) return { handled: false, reason: 'disabled' };
  if (!Array.isArray(pdfs) || !pdfs.length) return { handled: false, reason: 'no-pdfs' };
  if (!isEligibleDocSender(email.from, email.subject, email.body)) {
    return { handled: false, reason: 'ineligible-sender' };
  }

  const limited = pdfs.slice(0, MAX_PDFS);
  const filenames = limited.map(p => p.filename || 'attachment.pdf');

  const intent = await extractLoanIntent(email, filenames);
  if (!intent.isBorrowerDocs) {
    log('not-borrower-docs', { from: email.from, subject: email.subject });
    return { handled: false, reason: 'not-borrower-docs' };
  }
  if (!intent.loanNumber && !intent.borrowerName) {
    log('no-loan-identifier', { from: email.from, subject: email.subject });
    return { handled: false, reason: 'no-loan-identifier' };
  }

  const loan = await findLoanByNumberOrBorrower(intent.loanNumber, intent.borrowerName);
  if (!loan) {
    log('loan-not-found', {
      from: email.from,
      loanNumber: intent.loanNumber,
      borrowerName: intent.borrowerName
    });
    return { handled: false, reason: 'loan-not-found' };
  }

  const loanName = loan.properties?.['Borrower Name']?.title?.[0]?.plain_text
    ?? intent.borrowerName
    ?? 'Unknown borrower';
  const loanNumber = getLoanNumberFromPage(loan);
  const conditions = await getOpenConditionsForLoan(loan.id);

  const docs = [];
  for (const pdf of limited) {
    const filename = pdf.filename || 'attachment.pdf';
    const text = await extractPdfText(pdf.buffer);
    docs.push({ filename, text });
  }

  const classification = await classifyDocuments({
    email,
    loanName,
    loanNumber,
    conditions,
    docs
  });

  const subjectLine = `[Docs Received] ${loanName} — ${docs.length} file${docs.length === 1 ? '' : 's'}`;
  const bodyText = buildSummaryEmail({
    loanName,
    loanNumber,
    email,
    classification,
    openCount: conditions.length
  });

  if (DRY_RUN) {
    log('dry-run', {
      inbox: account?.label,
      loan: loanNumber || loanName,
      files: filenames,
      openConditions: conditions.length
    });
    return { handled: true, reason: 'dry-run' };
  }

  await sendToBothInboxes(subjectLine, bodyText);
  log('summary-sent', {
    inbox: account?.label,
    loan: loanNumber || loanName,
    files: filenames,
    openConditions: conditions.length,
    from: email.from
  });
  return { handled: true };
}

module.exports = {
  handle,
  isEligibleDocSender,
  buildSummaryEmail
};
