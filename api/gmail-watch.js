require('dotenv').config();
const fs   = require('fs');
const path = require('path');

const { getClients, getEbotClient, extractBody, getHeader } = require('../lib/gmail-client');
const { handle: processFeedback } = require('../lib/feedback-handler');
const { classify: aiClassify }               = require('../lib/classifier');
const { handle: createDraft }                = require('../lib/draft-handler');
const { load: loadState, save: saveState, pruneProcessed } = require('../lib/state');
const { load: loadStyleCtx }                 = require('../lib/style-context');
const { runIfDue }                           = require('../lib/digest-builder');

// Approval-bot imports
const { classify: keywordClassify,
        isUwmLoanSubject, isBrokerApprovalBundle } = require('../lib/email-classifier');
const { isApprovalPdfFilename }              = require('../lib/approval-letter');
const { isNewrezApprovalEmail,
        extractApprovalPdfUrl,
        downloadApprovalPdf }                = require('../lib/newrez-client');

const DRY_RUN                  = process.env.DRY_RUN === 'true';
const APPROVAL_PDF_ONLY        = process.env.APPROVAL_PDF_ONLY !== 'false';
const PRESERVE_UNREAD          = process.env.GMAIL_PRESERVE_UNREAD !== 'false';
const TIMEZONE                 = process.env.GMAIL_SCAN_TIMEZONE || 'America/New_York';
const MAX_PER_INBOX            = Number(process.env.GMAIL_MAX_MESSAGES_PER_INBOX) || 25;
const MAX_TOTAL_PER_INBOX      = Number(process.env.GMAIL_MAX_TOTAL_PER_INBOX_PER_SCAN) || 50;

// Single unified processed label — covers both old bots so nothing gets re-processed
const PROCESSED_LABEL          = process.env.GMAIL_PROCESSED_LABEL || 'mortgage-bot-processed';
// Also exclude emails already handled by the old broker-assistant bot
const EXTRA_EXCLUDE_LABEL      = 'broker-assistant-processed';

const labelIdCache = {};

function log(inbox, msgId, action, detail = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), inbox, msgId, action, ...detail }));
}

// ── State ────────────────────────────────────────────────────────────────────

const STATE_FILE = process.env.GMAIL_STATE_FILE
  || (process.env.VERCEL ? '/tmp/.mortgage-state.json' : path.join(__dirname, '..', 'data', 'state.json'));

function loadFileState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return {}; }
}
function saveFileState(s) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// ── Date helpers ─────────────────────────────────────────────────────────────

function getTodayDate() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date()).map(p => [p.type, p.value])
  );
  return `${parts.year}/${parts.month}/${parts.day}`;
}

// ── Label helpers ─────────────────────────────────────────────────────────────

async function ensureLabel(gmail, inboxLabel) {
  if (labelIdCache[inboxLabel]) return labelIdCache[inboxLabel];
  const { data } = await gmail.users.labels.list({ userId: 'me' });
  const existing = (data.labels ?? []).find(l => l.name === PROCESSED_LABEL);
  if (existing) { labelIdCache[inboxLabel] = existing.id; return existing.id; }
  const created = await gmail.users.labels.create({
    userId: 'me',
    requestBody: { name: PROCESSED_LABEL, labelListVisibility: 'labelShow', messageListVisibility: 'show' }
  });
  labelIdCache[inboxLabel] = created.data.id;
  return created.data.id;
}

async function markProcessed(gmail, inboxLabel, msgId, { wasUnread } = {}) {
  const labelId = await ensureLabel(gmail, inboxLabel);
  const addLabelIds = [labelId];
  if (PRESERVE_UNREAD && wasUnread) addLabelIds.push('UNREAD');
  await gmail.users.messages.modify({ userId: 'me', id: msgId, requestBody: { addLabelIds } });
}

// ── PDF helpers ───────────────────────────────────────────────────────────────

function hasPdf(payload) {
  function search(part) {
    if (part.mimeType === 'application/pdf' || (part.filename ?? '').toLowerCase().endsWith('.pdf')) return true;
    return (part.parts ?? []).some(search);
  }
  return search(payload);
}

function findAllPdfParts(payload, out = []) {
  if (payload.mimeType === 'application/pdf' || (payload.filename ?? '').toLowerCase().endsWith('.pdf')) out.push(payload);
  for (const child of payload.parts ?? []) findAllPdfParts(child, out);
  return out;
}

function listApprovalPdfParts(payload, subject = '', from = '') {
  const pdfs = findAllPdfParts(payload);
  if (!pdfs.length) return [];
  const ranked = pdfs.map(part => {
    const filename = part.filename ?? '';
    let score = 0;
    if (isApprovalPdfFilename(filename)) score += 10;
    if (/approvalletter|conditional.?approval|loan.?approval/i.test(filename)) score += 5;
    if (/1003|1008|closing|settlement|alta|disclosure|invoice|wire|deed|note/i.test(filename)) score -= 5;
    return { part, score };
  }).sort((a, b) => b.score - a.score);

  const positives = ranked.filter(r => r.score > 0).map(r => r.part);
  if (positives.length) return positives;

  const names = pdfs.map(p => p.filename ?? '');
  if (isBrokerApprovalBundle(subject, '', { hasPdf: true, from, pdfFilenames: names })) {
    return pdfs.filter(p => !/1003|1008|closing|settlement|alta|disclosure|invoice|wire|deed|note|intro/i.test(p.filename ?? ''));
  }
  return ranked[0]?.part ? [ranked[0].part] : [];
}

async function getAttachmentData(gmail, msgId, attachmentId) {
  const res = await gmail.users.messages.attachments.get({ userId: 'me', messageId: msgId, id: attachmentId });
  return Buffer.from(res.data.data, 'base64');
}

// ── Per-message processing ────────────────────────────────────────────────────

async function processMessage(account, msg, pendingState, styleCtx) {
  const { gmail, label, isJohn } = account;

  const full = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' });
  const { payload } = full.data;
  const labelIds = full.data.labelIds ?? [];
  const wasUnread = labelIds.includes('UNREAD');

  const headers   = payload.headers ?? [];
  const subject   = getHeader(headers, 'subject');
  const from      = getHeader(headers, 'from');
  const toHeader  = getHeader(headers, 'to');
  const ccHeader  = getHeader(headers, 'cc');
  const body      = extractBody(payload);
  const hasPDF    = hasPdf(payload);

  // Detect if John is TO'd directly or only CC'd
  const johnEmail = (process.env.JOHN_EMAIL ?? '').toLowerCase();
  const isDirectlyAddressed = toHeader.toLowerCase().includes(johnEmail);
  const isCc = !isDirectlyAddressed && ccHeader.toLowerCase().includes(johnEmail);
  const pdfFilenames = findAllPdfParts(payload).map(p => p.filename ?? '');
  const pdfPart   = hasPDF ? listApprovalPdfParts(payload, subject, from)[0] ?? null : null;
  const pdfFilename = pdfPart?.filename ?? pdfFilenames[0] ?? '';

  // ── Step 1: Keyword classify (fast, no API) ─────────────────────────────
  const kwClass = keywordClassify(subject, body, { hasPdf: hasPDF, from, pdfFilename, pdfFilenames });
  log(label, msg.id, 'keyword-classified', { subject, kwClass });

  // ── Step 2: Route approval PDFs to condition parser ─────────────────────
  if (kwClass === 'CONDITION_LIST') {
    const conditionParser = require('../lib/condition-parser');
    const pdfParts = hasPDF ? listApprovalPdfParts(payload, subject, from) : [];

    // NewRez: download PDF from link if no attachment
    if (!pdfParts.length && isNewrezApprovalEmail(from, subject)) {
      const html = extractBody(payload); // reuse; html already stripped but ok for URL extraction
      const url  = extractApprovalPdfUrl(html, body, subject);
      if (url) {
        try {
          const pdfBuffer = await downloadApprovalPdf(url);
          await conditionParser.process({ subject, from, body, pdfBuffer, msgId: msg.id, gmail, threadId: full.data.threadId, inboxLabel: label });
          log(label, msg.id, 'dispatched-condition-parser-newrez', { subject });
        } catch (err) {
          log(label, msg.id, 'newrez-pdf-error', { error: err.message });
        }
      }
      return { status: 'condition-list', wasUnread };
    }

    if (!pdfParts.length) {
      log(label, msg.id, 'skipped-no-approval-pdf', { subject });
      return { status: 'skipped-no-approval-pdf', wasUnread };
    }

    for (const part of pdfParts) {
      if (!part?.body?.attachmentId) continue;
      const pdfBuffer = await getAttachmentData(gmail, msg.id, part.body.attachmentId);
      await conditionParser.process({
        subject, from, body, pdfBuffer, msgId: msg.id,
        gmail, threadId: full.data.threadId, inboxLabel: label,
        attachmentFilename: part.filename ?? ''
      });
      log(label, msg.id, 'dispatched-condition-parser', { subject, filename: part.filename });
    }
    return { status: 'condition-list', wasUnread };
  }

  // ── Step 3: Non-PDF approval handlers (pre-approval, lender request) ────
  if (!APPROVAL_PDF_ONLY) {
    if (kwClass === 'PRE_APPROVAL') {
      const preApproval = require('../lib/pre-approval-handler');
      await preApproval.process({ subject, from, body });
      log(label, msg.id, 'dispatched-pre-approval', { subject });
      return { status: 'pre-approval', wasUnread };
    }
    if (kwClass === 'LENDER_REQUEST') {
      const lenderRequest = require('../lib/lender-request-handler');
      await lenderRequest.process({ subject, from, body });
      log(label, msg.id, 'dispatched-lender-request', { subject });
      return { status: 'lender-request', wasUnread };
    }
  }

  // ── Step 4: John's inbox only — AI classify for digest/drafts ──────────
  if (!isJohn) {
    log(label, msg.id, 'skipped-not-john', { subject });
    return { status: 'skipped', wasUnread };
  }

  const email = { messageId: msg.id, threadId: full.data.threadId, subject, from, body, isCc };
  const classification = await aiClassify(email, styleCtx);

  if (classification.category === 'IGNORE') {
    log(label, msg.id, 'ai-ignored', { subject, reason: classification.reason });
    return { status: 'ignored', wasUnread };
  }

  // CC emails: never draft a reply, include in digest only if URGENT
  if (isCc) {
    if (classification.category !== 'URGENT') {
      log(label, msg.id, 'cc-skipped', { subject, category: classification.category });
      return { status: 'ignored', wasUnread };
    }
    // URGENT CC: add to digest as a heads-up, no draft
    log(label, msg.id, 'cc-urgent-queued', { subject });
    pendingState.pendingItems.push({
      messageId: msg.id,
      category: 'URGENT',
      priority: classification.priority,
      summary: `[CC] ${classification.summary}`,
      from,
      subject,
      draftId: null,
      isCc: true,
      ts: new Date().toISOString()
    });
    return { status: 'urgent', wasUnread };
  }

  let draftId = null;
  if (classification.draftNeeded &&
      (classification.category === 'URGENT' || classification.category === 'RESPOND')) {
    draftId = await createDraft(email, classification, styleCtx);
  }

  pendingState.pendingItems = pendingState.pendingItems ?? [];
  pendingState.pendingItems.push({
    messageId: msg.id,
    category:  classification.category,
    priority:  classification.priority,
    summary:   classification.summary,
    from,
    subject,
    draftId,
    ts: new Date().toISOString()
  });

  log(label, msg.id, 'queued-for-digest', { subject, category: classification.category, draftId });
  return { status: classification.category.toLowerCase(), wasUnread };
}

// ── Per-inbox scan ────────────────────────────────────────────────────────────

async function scanInbox(account, pendingState, styleCtx) {
  const { gmail, label } = account;
  const today = getTodayDate();
  const query = `in:inbox after:${today} -label:${PROCESSED_LABEL} -label:${EXTRA_EXCLUDE_LABEL}`;

  const processedLabelId = await ensureLabel(gmail, label);

  let pageToken;
  let count = 0;
  const stats = { conditionList: 0, queued: 0, ignored: 0, skipped: 0, errors: 0 };

  while (count < MAX_TOTAL_PER_INBOX) {
    const batchSize = Math.min(MAX_PER_INBOX, MAX_TOTAL_PER_INBOX - count);
    const listRes = await gmail.users.messages.list({ userId: 'me', maxResults: batchSize, pageToken, q: query });
    const messages = listRes.data.messages ?? [];
    if (!messages.length) break;

    for (const msg of messages) {
      try {
        // Double-check label in case Gmail list is slightly stale
        const meta = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'metadata', metadataHeaders: ['labelIds'] });
        const lbls = meta.data.labelIds ?? [];
        if (lbls.includes(processedLabelId)) { count++; continue; }

        const result = await processMessage(account, msg, pendingState, styleCtx);

        if (!DRY_RUN) await markProcessed(gmail, label, msg.id, { wasUnread: result.wasUnread });

        if (result.status === 'condition-list') stats.conditionList++;
        else if (result.status === 'ignored' || result.status === 'skipped' || result.status === 'skipped-no-approval-pdf') stats.ignored++;
        else if (['urgent','respond','fyi'].includes(result.status)) stats.queued++;

      } catch (err) {
        log(label, msg.id, 'message-error', { error: err.message });
        stats.errors++;
      }
      count++;
      if (count >= MAX_TOTAL_PER_INBOX) break;
    }

    pageToken = listRes.data.nextPageToken;
    if (!pageToken) break;
  }

  log(label, null, 'inbox-scan-complete', { count, ...stats });
  return stats;
}

// ── Feedback inbox scan ───────────────────────────────────────────────────────

async function scanFeedbackInbox() {
  const ebotGmail = getEbotClient();
  if (!ebotGmail) {
    log('ebot', null, 'skipped-no-credentials', {});
    return { processed: 0 };
  }

  const today = getTodayDate();
  // Look back 7 days so feedback sent over a weekend isn't missed
  const sevenDaysAgo = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
  })();

  const processedLabelId = await ensureLabel(ebotGmail, 'ebot');
  const query = `in:inbox after:${sevenDaysAgo} -label:${PROCESSED_LABEL}`;
  const listRes = await ebotGmail.users.messages.list({ userId: 'me', maxResults: 20, q: query });
  const messages = listRes.data.messages ?? [];

  if (!messages.length) {
    log('ebot', null, 'no-feedback-messages', {});
    return { processed: 0 };
  }

  let processed = 0;
  for (const msg of messages) {
    try {
      const full    = await ebotGmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' });
      const headers = full.data.payload?.headers ?? [];
      const from    = getHeader(headers, 'from');
      const subject = getHeader(headers, 'subject');
      const body    = extractBody(full.data.payload);

      const result = await processFeedback({ messageId: msg.id, from, subject, body });
      log('ebot', msg.id, 'feedback-result', { from, subject, ...result });

      if (!DRY_RUN) await markProcessed(ebotGmail, 'ebot', msg.id);
      processed++;
    } catch (err) {
      log('ebot', msg.id, 'feedback-error', { error: err.message });
    }
  }

  return { processed };
}

// ── Main handler ──────────────────────────────────────────────────────────────

async function runScan() {
  const clients   = getClients();
  const styleCtx  = loadStyleCtx();

  // Load shared pending state (digest queue)
  const appState = loadState();
  appState.pendingItems = appState.pendingItems ?? [];

  // pendingState is a reference into appState so both get updated together
  const pendingState = appState;

  // Scan feedback inbox first so corrections apply to this scan's classifications
  let feedbackResult = { processed: 0 };
  try {
    feedbackResult = await scanFeedbackInbox();
  } catch (err) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), inbox: 'ebot', error: err.message }));
  }

  const results = {};
  for (const [key, account] of Object.entries(clients)) {
    try {
      results[key] = await scanInbox(account, pendingState, styleCtx);
    } catch (err) {
      console.error(JSON.stringify({ ts: new Date().toISOString(), inbox: account.label, error: err.message }));
      results[key] = { error: err.message };
    }
  }

  pruneProcessed(appState);
  saveState(appState);

  // Fire digest if a scheduled hour
  const digestResult = await runIfDue();

  return { ok: true, ts: new Date().toISOString(), results, feedback: feedbackResult, digest: digestResult };
}

module.exports = async (req, res) => {
  const syncScan = req.query?.wait === 'true'
    || process.env.GMAIL_SCAN_SYNC === 'true'
    || process.env.RENDER === 'true';

  if (syncScan) {
    try {
      const payload = await runScan();
      return res.status(200).json(payload);
    } catch (err) {
      console.error(JSON.stringify({ ts: new Date().toISOString(), action: 'scan-error', error: err.message }));
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  runScan().catch(err => console.error(err.message));
  return res.status(202).json({ ok: true, message: 'Scan started' });
};
