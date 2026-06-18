require('dotenv').config();
const { getClient, buildRawMessage } = require('./gmail-client');
const { load: loadState, save: saveState } = require('./state');

const DRY_RUN = process.env.DRY_RUN === 'true';
const DIGEST_HOURS = (process.env.DIGEST_HOURS || '8,12,16')
  .split(',').map(h => parseInt(h.trim(), 10));
const TIMEZONE = process.env.GMAIL_SCAN_TIMEZONE || 'America/New_York';

function log(action, detail) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), module: 'digest', action, ...detail }));
}

function currentHourInTz() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: TIMEZONE,
      hour: '2-digit',
      hour12: false
    }).formatToParts(new Date()).map(p => [p.type, p.value])
  );
  return parseInt(parts.hour, 10);
}

function isDueNow(state) {
  const hour = currentHourInTz();
  if (!DIGEST_HOURS.includes(hour)) return false;
  // Don't send twice in the same hour
  const key = `${new Date().toISOString().slice(0, 13)}`; // "2026-06-17T08"
  if (state.lastDigestKey === key) return false;
  return true;
}

function categoryLabel(cat) {
  if (cat === 'URGENT') return '🔴 URGENT';
  if (cat === 'RESPOND') return '🟡 RESPOND';
  return '🔵 FYI';
}

function buildDigestEmail(items) {
  const urgent = items.filter(i => i.category === 'URGENT').sort((a, b) => (a.priority ?? 5) - (b.priority ?? 5));
  const respond = items.filter(i => i.category === 'RESPOND').sort((a, b) => (a.priority ?? 5) - (b.priority ?? 5));
  const fyi = items.filter(i => i.category === 'FYI');

  const lines = [
    `BROKER ASSISTANT — EMAIL DIGEST`,
    `${new Date().toLocaleString('en-US', { timeZone: TIMEZONE, dateStyle: 'full', timeStyle: 'short' })}`,
    ``,
    `${urgent.length} urgent  |  ${respond.length} need reply  |  ${fyi.length} FYI`,
    ``
  ];

  if (urgent.length) {
    lines.push('━━━ URGENT ━━━');
    urgent.forEach((item, i) => {
      lines.push(`${i + 1}. ${item.summary}`);
      lines.push(`   From: ${item.from}`);
      lines.push(`   Subject: ${item.subject}`);
      if (item.draftId) lines.push(`   ✏️  Draft reply created — check Gmail Drafts`);
      lines.push('');
    });
  }

  if (respond.length) {
    lines.push('━━━ NEEDS REPLY ━━━');
    respond.forEach((item, i) => {
      lines.push(`${i + 1}. ${item.summary}`);
      lines.push(`   From: ${item.from}`);
      lines.push(`   Subject: ${item.subject}`);
      if (item.draftId) lines.push(`   ✏️  Draft reply created — check Gmail Drafts`);
      lines.push('');
    });
  }

  if (fyi.length) {
    lines.push('━━━ FYI ━━━');
    fyi.forEach((item, i) => {
      lines.push(`${i + 1}. ${item.summary}`);
      lines.push(`   From: ${item.from}`);
      lines.push('');
    });
  }

  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push(`Ignored ${items._ignoredCount ?? 0} automated/irrelevant emails.`);

  return lines.join('\n');
}

async function sendDigest(items) {
  const gmail = getClient();
  const johnEmail = process.env.JOHN_EMAIL;
  const hour = currentHourInTz();
  const period = hour < 12 ? 'Morning' : hour < 17 ? 'Midday' : 'Afternoon';
  const subject = `[Broker Assistant] ${period} Digest — ${urgent(items)}`;

  const body = buildDigestEmail(items);

  if (DRY_RUN) {
    log('dry-run', { subject, itemCount: items.length });
    console.log(body);
    return;
  }

  const raw = buildRawMessage({ from: johnEmail, to: johnEmail, subject, body });
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  log('sent', { subject, itemCount: items.length });
}

function urgent(items) {
  const u = items.filter(i => i.category === 'URGENT').length;
  const r = items.filter(i => i.category === 'RESPOND').length;
  if (u) return `${u} urgent, ${r} to respond`;
  if (r) return `${r} to respond`;
  return 'all clear';
}

async function runIfDue() {
  const state = loadState();
  if (!isDueNow(state)) return { sent: false, reason: 'not-due' };

  const items = state.pendingItems ?? [];
  if (!items.length) {
    log('skipped-empty', {});
    const key = `${new Date().toISOString().slice(0, 13)}`;
    state.lastDigestKey = key;
    state.pendingItems = [];
    saveState(state);
    return { sent: false, reason: 'no-items' };
  }

  await sendDigest(items);

  const key = `${new Date().toISOString().slice(0, 13)}`;
  state.lastDigestKey = key;
  state.pendingItems = [];
  saveState(state);

  return { sent: true, itemCount: items.length };
}

module.exports = { runIfDue, buildDigestEmail };
