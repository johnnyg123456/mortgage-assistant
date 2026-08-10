// Shared helper: tags every bot-drafted email with a "Needs Review" Gmail
// label so Christy can filter straight to bot-created drafts instead of
// scrolling through her whole Drafts folder to find them.
//
// Each mailbox (John's, Christy's) has its own label namespace, so the
// label ID is cached per account rather than globally.
const NEEDS_REVIEW_LABEL = 'Needs Review';
const labelIdCache = new Map(); // accountKey (email) -> labelId

function log(action, detail) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), module: 'gmail-labels', action, ...detail }));
}

async function ensureNeedsReviewLabel(gmail, accountKey) {
  if (labelIdCache.has(accountKey)) return labelIdCache.get(accountKey);

  const { data } = await gmail.users.labels.list({ userId: 'me' });
  const existing = (data.labels ?? []).find(
    l => (l.name ?? '').toLowerCase() === NEEDS_REVIEW_LABEL.toLowerCase()
  );
  if (existing) {
    labelIdCache.set(accountKey, existing.id);
    return existing.id;
  }

  const created = await gmail.users.labels.create({
    userId: 'me',
    requestBody: {
      name: NEEDS_REVIEW_LABEL,
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show'
    }
  });
  labelIdCache.set(accountKey, created.data.id);
  log('label-created', { accountKey, labelId: created.data.id });
  return created.data.id;
}

// Applies the "Needs Review" label to a just-created draft's underlying
// message. Never throws — labeling is a nice-to-have so Christy can filter
// her Drafts folder; it should never block a draft from being created.
async function labelDraftNeedsReview(gmail, accountKey, draftCreateResult) {
  try {
    const messageId = draftCreateResult?.data?.message?.id;
    if (!messageId) return;
    const labelId = await ensureNeedsReviewLabel(gmail, accountKey);
    await gmail.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: { addLabelIds: [labelId] }
    });
  } catch (err) {
    log('label-error', { accountKey, error: err.message });
  }
}

module.exports = { NEEDS_REVIEW_LABEL, ensureNeedsReviewLabel, labelDraftNeedsReview };
