/**
 * Processes feedback emails sent to ebot@libertygroupfunding.com by John.
 * Feedback is stored in data/feedback.json and injected into classifier + draft prompts.
 *
 * HOW TO USE:
 * Forward any email to ebot@libertygroupfunding.com with a note in the body:
 *
 *   "ignore this sender"          → adds sender to personal ignore list
 *   "ignore emails like this"     → adds subject pattern to ignore list
 *   "should have said: [text]"    → stores draft correction as example
 *   "don't draft for these"       → marks sender as no-draft
 *
 * Only emails FROM john@libertygroupfunding.com are processed.
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const FEEDBACK_FILE = path.join(__dirname, '..', 'data', 'feedback.json');
const JOHN_EMAIL   = (process.env.JOHN_EMAIL ?? 'john@libertygroupfunding.com').toLowerCase();

function log(action, detail) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), module: 'feedback', action, ...detail }));
}

function loadFeedback() {
  try { return JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf8')); }
  catch {
    return {
      ignoreSenders: [],
      ignoreSubjectPatterns: [],
      noDraftSenders: [],
      draftCorrections: [],
      updatedAt: null
    };
  }
}

function saveFeedback(fb) {
  fs.mkdirSync(path.dirname(FEEDBACK_FILE), { recursive: true });
  fb.updatedAt = new Date().toISOString();
  fs.writeFileSync(FEEDBACK_FILE, JSON.stringify(fb, null, 2));
}

function extractForwardedSender(body) {
  // Pull the original From: out of a forwarded email body
  const m = body.match(/^From:\s*(.+)$/im)
    ?? body.match(/[-]{3,}\s*Forwarded message\s*[-]{3,}[\s\S]*?From:\s*(.+)/im);
  return m ? m[1].trim() : null;
}

function extractForwardedSubject(body) {
  const m = body.match(/^Subject:\s*(.+)$/im);
  return m ? m[1].trim() : null;
}

async function parseFeedbackWithClaude(email) {
  const prompt = `John forwarded an email to his bot's feedback inbox with a correction note.

John's message / note:
"""
${email.body.slice(0, 2000)}
"""

Extract what correction John wants to make. Respond with raw JSON only:
{
  "action": "ignore_sender" | "ignore_subject" | "no_draft" | "draft_correction" | "unclear",
  "senderToIgnore": "email address extracted from forwarded email, if action is ignore_sender or no_draft",
  "subjectPattern": "key words from subject to match, if action is ignore_subject",
  "originalContext": "brief description of the email John forwarded",
  "correctedDraft": "what John says the reply should have said, if action is draft_correction",
  "johnNote": "John's exact instruction in his own words"
}`;

  const response = await anthropic.messages.create({
    model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }]
  });

  const raw = (response.content[0]?.text ?? '').replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
  return JSON.parse(raw);
}

async function handle(email) {
  // Security: only process feedback from John
  const senderEmail = (email.from ?? '').toLowerCase();
  if (!senderEmail.includes(JOHN_EMAIL)) {
    log('rejected-not-john', { from: email.from });
    return { processed: false, reason: 'not-john' };
  }

  log('processing', { from: email.from, subject: email.subject });

  let parsed;
  try {
    parsed = await parseFeedbackWithClaude(email);
  } catch (err) {
    log('parse-error', { error: err.message });
    return { processed: false, reason: 'parse-error' };
  }

  if (parsed.action === 'unclear') {
    log('unclear-feedback', { johnNote: parsed.johnNote });
    return { processed: false, reason: 'unclear' };
  }

  const fb = loadFeedback();

  if (parsed.action === 'ignore_sender' && parsed.senderToIgnore) {
    if (!fb.ignoreSenders.includes(parsed.senderToIgnore)) {
      fb.ignoreSenders.push(parsed.senderToIgnore);
      log('added-ignore-sender', { sender: parsed.senderToIgnore });
    }
  }

  if (parsed.action === 'ignore_subject' && parsed.subjectPattern) {
    if (!fb.ignoreSubjectPatterns.includes(parsed.subjectPattern)) {
      fb.ignoreSubjectPatterns.push(parsed.subjectPattern);
      log('added-ignore-subject', { pattern: parsed.subjectPattern });
    }
  }

  if (parsed.action === 'no_draft' && parsed.senderToIgnore) {
    if (!fb.noDraftSenders.includes(parsed.senderToIgnore)) {
      fb.noDraftSenders.push(parsed.senderToIgnore);
      log('added-no-draft-sender', { sender: parsed.senderToIgnore });
    }
  }

  if (parsed.action === 'draft_correction' && parsed.correctedDraft) {
    // Keep last 30 corrections as few-shot examples
    fb.draftCorrections.unshift({
      originalContext: parsed.originalContext,
      johnNote: parsed.johnNote,
      correctedDraft: parsed.correctedDraft,
      addedAt: new Date().toISOString()
    });
    fb.draftCorrections = fb.draftCorrections.slice(0, 30);
    log('added-draft-correction', { context: parsed.originalContext });
  }

  saveFeedback(fb);
  return { processed: true, action: parsed.action };
}

function load() {
  return loadFeedback();
}

module.exports = { handle, load };
