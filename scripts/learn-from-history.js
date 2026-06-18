/**
 * Analyzes last 6 months of John's sent mail to learn tone by recipient type.
 * Run: node scripts/learn-from-history.js
 * Output: data/style-context.json
 */
require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function makeGmailClient() {
  const auth = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    'http://127.0.0.1:8080'
  );
  auth.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  return google.gmail({ version: 'v1', auth });
}

function extractPart(payload, mimeType) {
  function search(part) {
    if (part.mimeType === mimeType && part.body?.data)
      return Buffer.from(part.body.data, 'base64').toString('utf8');
    for (const child of part.parts ?? []) { const r = search(child); if (r) return r; }
    return null;
  }
  return search(payload);
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractBody(payload) {
  const plain = extractPart(payload, 'text/plain');
  if (plain) return plain;
  const html = extractPart(payload, 'text/html');
  if (html) return stripHtml(html);
  return '';
}

function getHeader(headers, name) {
  return (headers ?? []).find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

// Strip the email signature block — everything after the first separator or NMLS line
function stripSignature(body) {
  const lines = body.split('\n');
  const cutPatterns = [
    /^--\s*$/,
    /nmls/i,
    /top\s+\d+%/i,
    /residential sales manager/i,
    /liberty group funding/i,
    /www\./i,
    /^\s*\d{3}[.\-\s]\d{3}[.\-\s]\d{4}/,
  ];
  const cutAt = lines.findIndex(l => cutPatterns.some(re => re.test(l)));
  const trimmed = cutAt > 0 ? lines.slice(0, cutAt) : lines;
  return trimmed.join('\n').trim();
}

// Strip quoted reply chains — keep only John's new content
function stripQuotedReply(body) {
  const lines = body.split('\n');
  const cutPatterns = [
    /^on .+ wrote:/i,
    /^from:/i,
    /^-----original message/i,
    /^>{1,}/,
  ];
  const cutAt = lines.findIndex(l => cutPatterns.some(re => re.test(l.trim())));
  const trimmed = cutAt > 0 ? lines.slice(0, cutAt) : lines;
  return trimmed.join('\n').trim();
}

function cleanBody(raw) {
  return stripSignature(stripQuotedReply(raw));
}

// Categorize recipient by domain/keywords
function categorizeRecipient(to, subject, body) {
  const t = `${to} ${subject} ${body}`.toLowerCase();
  if (/libertygroupfunding\.com/.test(to)) return 'internal';
  if (/uwm|newrez|acralending|amwest|nationsdirect|archome|cakemortgage|theloanstore|bluepoint|fundloans|orion|pennymac|prmg|loanstream|resicentral|emporiumtpo/.test(t)) return 'lender';
  if (/mytitleco|lawflorida|horizonabstract|homepartnerstitle|titleco|escrow|closing|settlement/.test(t)) return 'title';
  if (/realtor|realty|real estate|remax|keller|coldwell|berkshire/.test(t)) return 'realtor';
  if (/gmail|yahoo|hotmail|outlook|icloud|aol/.test(to.toLowerCase())) return 'client';
  return 'other';
}

function nMonthsAgoDate(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

async function fetchSentEmails(gmail, maxCount, monthsBack) {
  const after = nMonthsAgoDate(monthsBack);
  console.log(`  Fetching sent emails after ${after}...`);

  let allMessages = [];
  let pageToken;
  while (allMessages.length < maxCount) {
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      maxResults: Math.min(100, maxCount - allMessages.length),
      pageToken,
      q: `in:sent after:${after} -subject:"[mortgage bot]" -subject:"[broker assistant]" -subject:"Approvals -"`
    });
    const msgs = listRes.data.messages ?? [];
    allMessages = allMessages.concat(msgs);
    pageToken = listRes.data.nextPageToken;
    if (!pageToken || !msgs.length) break;
  }

  console.log(`  Found ${allMessages.length} sent messages. Fetching bodies...`);

  const emails = [];
  for (const msg of allMessages.slice(0, maxCount)) {
    try {
      const full = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' });
      const headers = full.data.payload?.headers ?? [];
      const rawBody = extractBody(full.data.payload);
      const body = cleanBody(rawBody);
      if (body.length < 10) continue;

      const to = getHeader(headers, 'to');
      const subject = getHeader(headers, 'subject');
      const category = categorizeRecipient(to, subject, body);

      emails.push({ to, subject, body, category });
    } catch { /* skip */ }
  }

  return emails;
}

async function fetchInboxSenders(gmail, monthsBack) {
  const after = nMonthsAgoDate(monthsBack);
  const listRes = await gmail.users.messages.list({
    userId: 'me', maxResults: 200,
    q: `in:inbox after:${after} -label:broker-assistant-processed`
  });
  const messages = listRes.data.messages ?? [];
  const senderCounts = {};
  for (const msg of messages) {
    try {
      const full = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'metadata', metadataHeaders: ['From'] });
      const from = getHeader(full.data.payload?.headers ?? [], 'from');
      if (!from || /libertygroupfunding|noreply|no-reply|donotreply/i.test(from)) continue;
      senderCounts[from] = (senderCounts[from] ?? 0) + 1;
    } catch { /* skip */ }
  }
  return senderCounts;
}

function groupByCategory(emails) {
  const groups = { client: [], lender: [], title: [], realtor: [], internal: [], other: [] };
  for (const e of emails) groups[e.category]?.push(e);
  return groups;
}

function formatEmailSamples(emails, max = 15) {
  return emails.slice(0, max).map((e, i) =>
    `[${i + 1}] To: ${e.to}\nSubject: ${e.subject}\n${e.body}`
  ).join('\n\n---\n\n');
}

async function analyzeWithClaude(groups, senderCounts) {
  const topSenders = Object.entries(senderCounts)
    .sort((a, b) => b[1] - a[1]).slice(0, 25)
    .map(([from, count]) => `${from} (${count})`);

  const counts = Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length]));
  console.log('  Email breakdown by recipient type:', counts);

  const prompt = `You are analyzing emails written by John, a high-volume mortgage broker at Liberty Group Funding.

Your job is to extract John's ACTUAL writing style so an AI can draft replies that sound exactly like him — not generic "professional" language, but his specific voice.

=== EMAILS TO CLIENTS (borrowers) — ${groups.client.length} found ===
${formatEmailSamples(groups.client, 12)}

=== EMAILS TO LENDERS (UWM, NewRez, ResiCentral, etc.) — ${groups.lender.length} found ===
${formatEmailSamples(groups.lender, 12)}

=== EMAILS TO TITLE / CLOSING — ${groups.title.length} found ===
${formatEmailSamples(groups.title, 8)}

=== EMAILS TO REALTORS — ${groups.realtor.length} found ===
${formatEmailSamples(groups.realtor, 8)}

=== EMAILS TO INTERNAL TEAM — ${groups.internal.length} found ===
${formatEmailSamples(groups.internal, 8)}

=== TOP SENDERS TO JOHN (who he receives most from) ===
${topSenders.join(', ')}

Analyze John's ACTUAL tone and patterns. Look for:
- How long are his replies? (word count range)
- Does he use greetings? Which ones?
- How does he sign off? (not the signature block — the actual closing word/phrase before the sig)
- Is he warm, blunt, casual, formal?
- Does he use bullet points or prose?
- Any recurring phrases or language he uses?
- How does his tone shift between clients vs lenders vs title vs realtors?

Respond with raw JSON only (no markdown fences):
{
  "tone": "2-3 sentences capturing John's overall voice with specific examples from the emails",
  "toneByAudience": {
    "client": "how he writes to borrowers — specific patterns",
    "lender": "how he writes to lenders/underwriters — specific patterns",
    "title": "how he writes to title/closing agents",
    "realtor": "how he writes to realtors",
    "internal": "how he writes to his team"
  },
  "typicalLength": "describe typical reply length (e.g., 1-3 sentences, rarely more than 50 words)",
  "greetings": ["list of greetings John actually uses, in order of frequency"],
  "signOffs": ["list of actual sign-off words/phrases John uses before his signature, in order of frequency"],
  "recurringPhrases": ["specific phrases or expressions John uses regularly"],
  "sampleSignOff": "the single most common sign-off phrase only (e.g. 'Thanks,' or 'Let me know.')",
  "importantSenders": ["email addresses that appear frequently and seem operationally important"],
  "ignorePatterns": ["subject or sender patterns that are clearly automated noise — specific to what you see"],
  "urgentKeywords": ["domain-specific urgency terms visible in these emails"],
  "observations": "2-3 sentences on John's email behavior and priorities"
}`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }]
  });

  const raw = (response.content[0]?.text ?? '').replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
  return JSON.parse(raw);
}

async function main() {
  const MONTHS_BACK = 6;
  const MAX_SENT = 200;

  console.log(`Learning from last ${MONTHS_BACK} months of email history (up to ${MAX_SENT} sent emails)...`);
  const gmail = makeGmailClient();

  const [sentEmails, senderCounts] = await Promise.all([
    fetchSentEmails(gmail, MAX_SENT, MONTHS_BACK),
    fetchInboxSenders(gmail, MONTHS_BACK)
  ]);

  console.log(`\nAnalyzed ${sentEmails.length} sent emails across recipient types.`);

  const groups = groupByCategory(sentEmails);
  const analysis = await analyzeWithClaude(groups, senderCounts);

  analysis.learnedAt  = new Date().toISOString();
  analysis.emailsAnalyzed = sentEmails.length;
  analysis.monthsBack = MONTHS_BACK;

  const outputPath = path.join(__dirname, '..', 'data', 'style-context.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(analysis, null, 2));

  console.log('\n✓ Style context saved to data/style-context.json\n');
  console.log('Tone:', analysis.tone);
  console.log('\nSign-offs:', (analysis.signOffs ?? []).join(' | '));
  console.log('Greetings:', (analysis.greetings ?? []).join(' | '));
  console.log('\nTone by audience:');
  for (const [k, v] of Object.entries(analysis.toneByAudience ?? {})) {
    console.log(`  ${k}: ${v}`);
  }
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
