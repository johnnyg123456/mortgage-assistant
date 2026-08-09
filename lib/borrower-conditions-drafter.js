require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { getClients } = require('./gmail-client');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const DRY_RUN = process.env.DRY_RUN === 'true';
// Opt-out flag — on by default; set false to disable without a redeploy.
const ENABLED = process.env.BORROWER_CONDITIONS_DRAFT_ENABLED !== 'false';

function log(action, detail) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), module: 'borrower-conditions-drafter', action, ...detail }));
}

function stripConditionCode(title) {
  return (title ?? '').replace(/^[A-Za-z0-9]{1,6}\s*\|\s*/, '').trim();
}

function encodeMimeHeader(value) {
  const text = (value ?? '').toString();
  if (!text || /^[\x00-\x7F]*$/.test(text)) return text;
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  return `=?UTF-8?B?${b64}?=`;
}

// Draft with no To: — Christy fills in the borrower address before sending.
function buildNoRecipientRaw({ from, subject, body }) {
  const lines = [
    `From: ${from}`,
    `Subject: ${encodeMimeHeader(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    body ?? ''
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

function firstNameFromLoanName(loanName) {
  const first = (loanName ?? '').trim().split(/\s+/)[0];
  if (!first || /^loan$/i.test(first) || /^unknown$/i.test(first)) return null;
  return first;
}

async function writeBorrowerEmail({ loanName, loanNumber, openTitles, addedList }) {
  const firstName = firstNameFromLoanName(loanName);
  const openLines = openTitles.length
    ? openTitles.map(t => `- ${stripConditionCode(t)}`).join('\n')
    : '(none)';
  const addedLines = (addedList ?? []).length
    ? addedList.map(t => `- ${stripConditionCode(t)}`).join('\n')
    : openLines;

  const prompt = `Write a warm, plain-English email FROM Christy (mortgage processor at Liberty Group Funding) TO the borrower about documents still needed for their loan.

Borrower name: ${loanName}${loanNumber ? ` (loan #${loanNumber})` : ''}
Greeting first name (use if natural): ${firstName || '(use Hi there,)'}

Newly added underwriting conditions (raw lender language — translate these; do not paste jargon or internal codes):
${addedLines}

All currently open conditions (what's still needed overall — cover these in the list):
${openLines}

Requirements:
- Sign off as Christy (not John).
- Warm, clear, helpful — a borrower with no mortgage jargon should understand every bullet.
- Short intro (1–2 sentences) explaining the lender needs a few more items.
- Bulleted list of what's needed in plain English.
- Brief closing offering to help if they have questions.
- Write ONLY the email body — no subject line, no "Here is a draft", no placeholder like [Borrower Name] for the greeting if you have a first name.
- Do NOT invent a borrower email address, phone number, portal link, or deadline that wasn't provided.
- Do NOT mention Notion, underwriting codes, or internal systems.`;

  const response = await anthropic.messages.create({
    model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
    max_tokens: 700,
    messages: [{ role: 'user', content: prompt }]
  });

  return (response.content[0]?.text ?? '').trim();
}

async function createChristyDraft({ subject, body }) {
  const clients = getClients();
  const christy = clients.christy;
  if (!christy?.gmail || !christy.email) {
    throw new Error('Christy Gmail client not configured');
  }

  const raw = buildNoRecipientRaw({
    from: christy.email,
    subject,
    body
  });

  const result = await christy.gmail.users.drafts.create({
    userId: 'me',
    requestBody: { message: { raw } }
  });

  return result.data.id;
}

/**
 * After new conditions are synced to Notion, draft a borrower-facing
 * "documents needed" email in Christy's inbox (no To: address).
 * Never auto-sends. No-ops when disabled, dry-run, or nothing was added.
 *
 * @returns {{ drafted: boolean, draftId?: string|null, reason?: string }}
 */
async function draftForNewConditions({
  loanName,
  loanNumber = '',
  addedList = [],
  openTitles = []
} = {}) {
  if (!ENABLED) return { drafted: false, reason: 'disabled' };
  if (!addedList.length) return { drafted: false, reason: 'nothing-added' };

  const name = loanName || 'there';
  const titles = (openTitles?.length ? openTitles : addedList).filter(Boolean);
  if (!titles.length) return { drafted: false, reason: 'no-open-conditions' };

  const body = await writeBorrowerEmail({
    loanName: name,
    loanNumber,
    openTitles: titles,
    addedList
  });

  if (!body) {
    log('empty-body', { loan: name });
    return { drafted: false, reason: 'empty-body' };
  }

  const subject = `Documents needed for your loan${name && name !== 'there' ? ` — ${name}` : ''}`;

  if (DRY_RUN) {
    log('dry-run', {
      loan: name,
      loanNumber,
      added: addedList.length,
      open: titles.length,
      preview: body.slice(0, 160)
    });
    return { drafted: true, draftId: null, reason: 'dry-run' };
  }

  const draftId = await createChristyDraft({ subject, body });
  log('draft-created', {
    loan: name,
    loanNumber,
    draftId,
    added: addedList.length,
    open: titles.length
  });
  return { drafted: true, draftId };
}

module.exports = {
  draftForNewConditions,
  buildNoRecipientRaw,
  stripConditionCode,
  firstNameFromLoanName
};
