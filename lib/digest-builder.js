require('dotenv').config();
const { getClient, buildRawHtmlMessage } = require('./gmail-client');
const { load: loadState, save: saveState } = require('./state');

const DRY_RUN     = process.env.DRY_RUN === 'true';
const DIGEST_HOURS = (process.env.DIGEST_HOURS || '8,12,16')
  .split(',').map(h => parseInt(h.trim(), 10));
const TIMEZONE    = process.env.GMAIL_SCAN_TIMEZONE || 'America/New_York';

function log(action, detail) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), module: 'digest', action, ...detail }));
}

function currentHourInTz() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, hour: '2-digit', hour12: false })
      .formatToParts(new Date()).map(p => [p.type, p.value])
  );
  return parseInt(parts.hour, 10);
}

function isDueNow(state) {
  const hour = currentHourInTz();
  if (!DIGEST_HOURS.includes(hour)) return false;
  const key = new Date().toISOString().slice(0, 13);
  if (state.lastDigestKey === key) return false;
  return true;
}

function gmailLink(messageId) {
  if (!messageId) return null;
  return `https://mail.google.com/mail/u/0/#all/${messageId}`;
}

function escHtml(str) {
  return (str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildSection({ items, title, accentColor, bgColor, badgeColor, badgeText, isCcSection = false }) {
  if (!items.length) return '';

  const rows = items.map(item => {
    const link = gmailLink(item.messageId);
    const openBtn = link
      ? `<a href="${link}" style="display:inline-block;padding:4px 10px;background:${accentColor};color:#fff;border-radius:4px;text-decoration:none;font-size:12px;font-weight:600;">Open Email</a>`
      : '';
    const draftBadge = item.draftId
      ? `<span style="display:inline-block;margin-left:8px;padding:2px 8px;background:#6366f1;color:#fff;border-radius:4px;font-size:11px;">✏️ Draft ready</span>`
      : '';
    const ccNote = isCcSection || item.isCc
      ? `<div style="font-size:12px;color:#64748b;margin-top:2px;">You were CC'd — no reply needed, worth a look.</div>`
      : '';

    return `
      <tr>
        <td style="padding:12px 16px;border-bottom:1px solid #e2e8f0;vertical-align:top;">
          <div style="font-weight:600;color:#1e293b;font-size:14px;margin-bottom:2px;">${escHtml(item.summary)}</div>
          <div style="font-size:12px;color:#475569;margin-bottom:6px;">
            <strong>From:</strong> ${escHtml(item.from)} &nbsp;·&nbsp;
            <strong>Subject:</strong> ${escHtml(item.subject)}
          </div>
          ${ccNote}
          <div style="margin-top:6px;">${openBtn}${draftBadge}</div>
        </td>
      </tr>`;
  }).join('');

  return `
    <div style="margin-bottom:24px;">
      <div style="background:${accentColor};padding:10px 16px;border-radius:8px 8px 0 0;display:flex;align-items:center;gap:10px;">
        <span style="font-size:15px;font-weight:700;color:#fff;letter-spacing:0.5px;">${escHtml(title)}</span>
        <span style="background:rgba(255,255,255,0.25);color:#fff;font-size:12px;font-weight:700;padding:2px 8px;border-radius:12px;">${items.length}</span>
      </div>
      <table width="100%" cellpadding="0" cellspacing="0" style="background:${bgColor};border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px;border-collapse:collapse;">
        ${rows}
      </table>
    </div>`;
}

function buildDigestHtml(items, period, ignoredCount) {
  const urgent  = items.filter(i => i.category === 'URGENT' && !i.isCc).sort((a, b) => (a.priority ?? 5) - (b.priority ?? 5));
  const urgentCc = items.filter(i => i.category === 'URGENT' && i.isCc);
  const respond = items.filter(i => i.category === 'RESPOND').sort((a, b) => (a.priority ?? 5) - (b.priority ?? 5));
  const fyi     = items.filter(i => i.category === 'FYI');

  const dateStr = new Date().toLocaleString('en-US', { timeZone: TIMEZONE, dateStyle: 'full', timeStyle: 'short' });

  const urgentSection = buildSection({
    items: urgent,
    title: '🔴 URGENT — Action Required',
    accentColor: '#dc2626',
    bgColor: '#fff5f5'
  });

  const urgentCcSection = buildSection({
    items: urgentCc,
    title: '🟠 URGENT — CC\'d (FYI Only)',
    accentColor: '#ea580c',
    bgColor: '#fff7ed',
    isCcSection: true
  });

  const respondSection = buildSection({
    items: respond,
    title: '🟡 Needs Reply',
    accentColor: '#d97706',
    bgColor: '#fffbeb'
  });

  const fyiSection = buildSection({
    items: fyi,
    title: '🔵 FYI',
    accentColor: '#2563eb',
    bgColor: '#eff6ff'
  });

  const allClear = !urgent.length && !urgentCc.length && !respond.length && !fyi.length
    ? `<div style="text-align:center;padding:32px;color:#64748b;font-size:15px;">✅ Inbox clear — nothing needs your attention.</div>`
    : '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:620px;margin:0 auto;padding:20px 12px;">

    <!-- Header -->
    <div style="background:linear-gradient(135deg,#1e3a5f 0%,#2563eb 100%);border-radius:10px;padding:20px 24px;margin-bottom:20px;">
      <div style="font-size:11px;font-weight:600;color:rgba(255,255,255,0.7);letter-spacing:1.5px;text-transform:uppercase;">Liberty Group Funding</div>
      <div style="font-size:20px;font-weight:700;color:#fff;margin:4px 0;">${period} Email Digest</div>
      <div style="font-size:12px;color:rgba(255,255,255,0.7);">${escHtml(dateStr)}</div>
    </div>

    <!-- Summary bar -->
    <div style="display:flex;gap:10px;margin-bottom:20px;">
      <div style="flex:1;background:#fff;border:1px solid #fecaca;border-radius:8px;padding:12px;text-align:center;">
        <div style="font-size:24px;font-weight:700;color:#dc2626;">${urgent.length}</div>
        <div style="font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;">Urgent</div>
      </div>
      <div style="flex:1;background:#fff;border:1px solid #fde68a;border-radius:8px;padding:12px;text-align:center;">
        <div style="font-size:24px;font-weight:700;color:#d97706;">${respond.length}</div>
        <div style="font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;">Need Reply</div>
      </div>
      <div style="flex:1;background:#fff;border:1px solid #bfdbfe;border-radius:8px;padding:12px;text-align:center;">
        <div style="font-size:24px;font-weight:700;color:#2563eb;">${fyi.length}</div>
        <div style="font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;">FYI</div>
      </div>
      <div style="flex:1;background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:12px;text-align:center;">
        <div style="font-size:24px;font-weight:700;color:#94a3b8;">${ignoredCount}</div>
        <div style="font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;">Ignored</div>
      </div>
    </div>

    ${allClear}
    ${urgentSection}
    ${urgentCcSection}
    ${respondSection}
    ${fyiSection}

    <div style="text-align:center;font-size:11px;color:#94a3b8;margin-top:16px;">
      Mortgage Assistant · Liberty Group Funding
    </div>
  </div>
</body>
</html>`;
}

async function sendDigest(items, ignoredCount) {
  const gmail     = getClient();
  const johnEmail = process.env.JOHN_EMAIL;
  const hour      = currentHourInTz();
  const period    = hour < 12 ? 'Morning' : hour < 17 ? 'Midday' : 'Afternoon';

  const urgent  = items.filter(i => i.category === 'URGENT').length;
  const respond = items.filter(i => i.category === 'RESPOND').length;
  const subjectLine = urgent
    ? `[Digest] ${period} — ${urgent} urgent, ${respond} to respond`
    : respond
      ? `[Digest] ${period} — ${respond} to respond`
      : `[Digest] ${period} — all clear`;

  const html = buildDigestHtml(items, period, ignoredCount);

  if (DRY_RUN) {
    log('dry-run', { subjectLine, itemCount: items.length });
    return;
  }

  const raw = buildRawHtmlMessage({ from: johnEmail, to: johnEmail, subject: subjectLine, html });
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  log('sent', { subjectLine, itemCount: items.length });
}

async function runIfDue() {
  const state = loadState();
  if (!isDueNow(state)) return { sent: false, reason: 'not-due' };

  const items        = state.pendingItems ?? [];
  const ignoredCount = state._ignoredCount ?? 0;

  if (!items.length) {
    log('skipped-empty', {});
    state.lastDigestKey  = new Date().toISOString().slice(0, 13);
    state.pendingItems   = [];
    state._ignoredCount  = 0;
    saveState(state);
    return { sent: false, reason: 'no-items' };
  }

  await sendDigest(items, ignoredCount);

  state.lastDigestKey  = new Date().toISOString().slice(0, 13);
  state.pendingItems   = [];
  state._ignoredCount  = 0;
  saveState(state);

  return { sent: true, itemCount: items.length };
}

module.exports = { runIfDue, buildDigestHtml };
