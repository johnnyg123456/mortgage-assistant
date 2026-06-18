require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { getClient, buildRawMessage, getHeader } = require('./gmail-client');
const { buildSystemPrompt } = require('./style-context');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const DRY_RUN = process.env.DRY_RUN === 'true';

function log(action, detail) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), module: 'draft-handler', action, ...detail }));
}

const TIMEZONE = process.env.GMAIL_SCAN_TIMEZONE || 'America/New_York';

function isChristyAfterHours() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: TIMEZONE,
      hour: '2-digit',
      hour12: false,
      weekday: 'short'
    }).formatToParts(new Date()).map(p => [p.type, p.value])
  );
  const hour = parseInt(parts.hour, 10);
  const isWeekend = ['Sat', 'Sun'].includes(parts.weekday);
  return isWeekend || hour >= 17 || hour < 9;
}

function isAboutChristy(emailBody, subject) {
  const text = `${subject} ${emailBody}`.toLowerCase();
  return /\bchristy\b|\bcgarboza\b|\bc\.garboza\b/i.test(text);
}

async function generateDraftBody(email, classification, styleCtx) {
  const systemPrompt = buildSystemPrompt(styleCtx, email);
  const bodyPreview = (email.body ?? '').slice(0, 2000);

  // If the email involves Christy and it's outside her 9-5 EST hours, tell the sender
  const christyContext = isAboutChristy(email.body, email.subject) && isChristyAfterHours()
    ? `\nIMPORTANT: This email involves Christy. It is currently after 5pm EST (or weekend). The reply should let the sender know that you'll pass this along to Christy and she'll handle it when she's back in. Do not commit to Christy doing something immediately.`
    : '';

  const prompt = `Write a reply to this email for John.

From: ${email.from}
Subject: ${email.subject}
Body:
${bodyPreview}

Draft context: ${classification.draftContext || classification.summary}${christyContext}

Write ONLY the body of the reply — no subject line, no "Here is a draft:", no explanation.
Match John's tone exactly. Keep it brief and professional.`;

  const response = await anthropic.messages.create({
    model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    system: systemPrompt,
    messages: [{ role: 'user', content: prompt }]
  });

  return response.content[0]?.text ?? '';
}

async function createGmailDraft(email, draftBody) {
  const gmail = getClient();
  const johnEmail = process.env.JOHN_EMAIL;

  // Get Message-ID and threadId from the original message for threading
  let messageId = '';
  let threadId = email.threadId;
  try {
    const meta = await gmail.users.messages.get({
      userId: 'me',
      id: email.messageId,
      format: 'metadata',
      metadataHeaders: ['Message-ID', 'Subject']
    });
    const headers = meta.data.payload?.headers ?? [];
    messageId = getHeader(headers, 'Message-ID');
    threadId = threadId || meta.data.threadId;
  } catch { /* non-fatal */ }

  const replySubject = (email.subject ?? '').toLowerCase().startsWith('re:')
    ? email.subject
    : `Re: ${email.subject}`;

  const raw = buildRawMessage({
    from: johnEmail,
    to: email.from,
    subject: replySubject,
    body: draftBody,
    inReplyTo: messageId || undefined,
    references: messageId || undefined
  });

  const result = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: {
      message: {
        raw,
        threadId: threadId || undefined
      }
    }
  });

  return result.data.id;
}

async function handle(email, classification, styleCtx) {
  log('start', { messageId: email.messageId, subject: email.subject });

  if (DRY_RUN) {
    log('dry-run-skipped', { messageId: email.messageId });
    return null;
  }

  try {
    const draftBody = await generateDraftBody(email, classification, styleCtx);
    const draftId = await createGmailDraft(email, draftBody);
    log('draft-created', { messageId: email.messageId, subject: email.subject, draftId });
    return draftId;
  } catch (err) {
    log('draft-error', { messageId: email.messageId, error: err.message });
    return null;
  }
}

module.exports = { handle };
