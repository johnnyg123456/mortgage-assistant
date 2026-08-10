require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { getClients } = require('./gmail-client');
const { load: loadStyleCtx, buildSystemPrompt } = require('./style-context');
const { labelDraftNeedsReview } = require('./gmail-labels');

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

// Translates only the newly-added conditions (not the full open list) so
// borrowers aren't re-asked for items already covered in a prior draft.
async function writeBorrowerEmail({ loanName, loanNumber, addedList }) {
  const firstName = firstNameFromLoanName(loanName);
  const addedLines = addedList.map(t => `- ${stripConditionCode(t)}`).join('\n');

  const styleCtx = loadStyleCtx();
  const systemPrompt = buildSystemPrompt(styleCtx, { from: 'borrower@gmail.com', subject: 'Documents needed', body: '' }) +
    `\n\nNOTE: You are drafting this one as Christy, the processor — not John. Sign off as Christy. This goes to a borrower/client, so keep it warm and easy to understand — no lender jargon or internal codes.

This email must read as a real, personally-written message from Christy — not an AI-generated one. The borrower should never suspect a bot wrote it. Avoid stiff AI patterns: no "I hope this email finds you well," no over-formal structure, no robotic transitions, no em-dashes used as a crutch, no listing things in a way that feels templated. Write the way a busy, friendly processor actually types — natural, a little informal, contractions are fine.`;

  const prompt = `Write an email to a mortgage borrower listing documents/items still needed for their loan to move forward.

Borrower name: ${loanName}${loanNumber ? ` (loan #${loanNumber})` : ''}
Greeting first name (use if natural): ${firstName || '(use Hi there,)'}

Newly added underwriting conditions (raw lender language — translate this into plain English a non-mortgage person would understand — don't just reformat the jargon, explain briefly what's needed and, where the reason isn't obvious, why):
${addedLines}

Write ONLY the body of the email — no subject line, no "Here is a draft". Warm, brief, sounds like a real person. Do not invent deadlines. Do not tell the borrower they are approved, denied, or "should be fine" — only note what's still needed.`;

  const response = await anthropic.messages.create({
    model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
    max_tokens: 700,
    system: systemPrompt,
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

  const raw = buildNoRecipientRaw({ from: christy.email, subject, body });

  const result = await christy.gmail.users.drafts.create({
    userId: 'me',
    requestBody: { message: { raw } }
  });

  await labelDraftNeedsReview(christy.gmail, christy.email, result);

  return result.data.id;
}

async function draftForNewConditions({
  loanName,
  loanNumber = '',
  addedList = []
} = {}) {
  if (!ENABLED) return { drafted: false, reason: 'disabled' };
  if (!addedList.length) return { drafted: false, reason: 'nothing-added' };

  const name = loanName || 'there';
  const body = await writeBorrowerEmail({ loanName: name, loanNumber, addedList });

  if (!body) {
    log('empty-body', { loan: name });
    return { drafted: false, reason: 'empty-body' };
  }

  const subject = `DRAFT — ${name}${loanNumber ? ` #${loanNumber}` : ''} — Documents Needed (add borrower email before sending)`;

  if (DRY_RUN) {
    log('dry-run', { loan: name, loanNumber, added: addedList.length, preview: body.slice(0, 160) });
    return { drafted: true, draftId: null, reason: 'dry-run' };
  }

  const draftId = await createChristyDraft({ subject, body });
  log('draft-created', { loan: name, loanNumber, draftId, added: addedList.length });
  return { drafted: true, draftId };
}

module.exports = {
  draftForNewConditions,
  buildNoRecipientRaw,
  stripConditionCode,
  firstNameFromLoanName
};
