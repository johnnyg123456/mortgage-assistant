// Shared sender/subject detection for email routing (no handler imports).

const LENDER_ROLE_KEYWORDS = [
  'underwriter', 'account manager', 'account executive', 'processor',
  'closer', 'funding manager', 'production partner',
  'registration analyst', 'wholesale ops', 'loan setup', 'setup analyst'
];

const TITLE_CLOSING_SIGNALS = [
  'land transfer', 'title company', 'settlement agent', 'closing attorney',
  'escrow officer', 'title agent', 'signed docs reviewed', 'good to disburse',
  'closing package', 'alta/master', 'alta settlement', 'certified copy of the mortgage',
  'post closing', 'wire instructions', 'closing protection letter', 'prelim cd',
  'executed closed loan package', 'original note and original note addendum'
];

const LENDER_FROM_RES = [
  /uwm\.com/i, /newrez/i, /acralending/i, /amwest/i, /nationsdirect/i,
  /archome/i, /cakemortgage/i, /theloanstore/i, /bluepoint/i, /fundloans/i,
  /orion/i, /openmortgage/i, /themls\.com/i, /pennymac/i, /prmg/i,
  /loanstream/i, /planet\s*home/i, /citadel/i, /resicentral/i
];

const BROKER_DOMAINS = ['libertygroupfunding.com'];
const BULK_SENDER_RE = /noreply|no-reply|donotreply|notifications?@/i;

function isTitleCompanySubject(subject) {
  return /^[^;]{1,80}\s+\/\s*-\s+/i.test((subject ?? '').trim());
}

function isTitleOrClosingEmail(from, subject, body) {
  const text = `${from} ${subject} ${body}`.toLowerCase();
  if (isTitleCompanySubject(subject)) return true;
  if (TITLE_CLOSING_SIGNALS.some(k => text.includes(k))) return true;
  if (/landtransfer|titleco|title\.com|escrow|closing\.com|settlements?\./i.test(from ?? '')) {
    return true;
  }
  return false;
}

function isBrokerEmail(from) {
  const lower = (from ?? '').toLowerCase();
  if (BROKER_DOMAINS.some(d => lower.includes(`@${d}`) || lower.includes(d))) return true;
  const john    = (process.env.JOHN_EMAIL ?? '').toLowerCase();
  const christy = (process.env.CHRISTINA_EMAIL ?? '').toLowerCase();
  if (john && lower.includes(john)) return true;
  if (christy && lower.includes(christy)) return true;
  return false;
}

function isDirectLenderEmail(from) {
  const value = (from ?? '').trim();
  if (!value || BULK_SENDER_RE.test(value)) return false;
  if (isBrokerEmail(from)) return false;
  return /@[a-z0-9.-]+\.[a-z]{2,}/i.test(value);
}

function isKnownLenderEmployeeEmail(from, body) {
  if (!isDirectLenderEmail(from)) return false;

  const fromLower = (from ?? '').toLowerCase();
  if (LENDER_FROM_RES.some(re => re.test(fromLower))) return true;

  const text = `${from} ${body}`.toLowerCase();
  if (/settlement agent|title company|escrow officer|land transfer|closing attorney|title insurance/i.test(text)) {
    return false;
  }
  return LENDER_ROLE_KEYWORDS.some(k => text.includes(k));
}

module.exports = {
  LENDER_ROLE_KEYWORDS,
  isTitleOrClosingEmail,
  isKnownLenderEmployeeEmail,
  isBrokerEmail,
  isDirectLenderEmail
};
