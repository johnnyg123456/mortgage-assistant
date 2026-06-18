const {
  BORROWER_LAST_NAME_PROPERTY,
  LENDER_PROPERTY
} = require('./notion-schema');

const LENDER_HINTS = [
  { re: /uwm\.com|united wholesale mortgage|\buwm\b/i, name: 'UWM' },
  { re: /newrez|myaccount\.newrez/i, name: 'Newrez' },
  { re: /acra lending|acralending/i, name: 'Acra' },
  { re: /nations direct/i, name: 'Nations Direct' },
  { re: /amwest/i, name: 'AmWest' },
  { re: /arc home|archome/i, name: 'ARC' },
  { re: /cake mortgage|\bcake\b/i, name: 'Cake' },
  { re: /the loan store|loanstore|tls/i, name: 'The Loan Store' },
  { re: /bluepoint/i, name: 'BluePoint' },
  { re: /fundloans/i, name: 'FundLoans' },
  { re: /orion/i, name: 'Orion' },
  { re: /open mortgage/i, name: 'Open Mortgage' },
  { re: /the lender/i, name: 'The Lender' },
  { re: /pennymac/i, name: 'PennyMac' },
  { re: /planet home|planet home lending/i, name: 'Planet Home' },
  { re: /prmg/i, name: 'PRMG' },
  { re: /loanstream/i, name: 'LoanStream' }
];

function extractBorrowerLastName(fullName) {
  const raw = (fullName ?? '').trim();
  if (!raw) return null;

  const comma = raw.match(/^([^,]+),\s*(.+)$/);
  if (comma) return comma[1].trim();

  const parts = raw.split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

function detectLenderName({ from = '', subject = '', pdfText = '', parserLender = null } = {}) {
  if (parserLender) return parserLender;

  const haystack = `${from} ${subject} ${pdfText}`.slice(0, 8000);
  for (const { re, name } of LENDER_HINTS) {
    if (re.test(haystack)) return name;
  }

  const fromName = (from ?? '').match(/^([^<]+)</);
  if (fromName) {
    const label = fromName[1].trim().replace(/"/g, '');
    if (label && !/mortgage bot|liberty group/i.test(label)) return label.slice(0, 80);
  }

  const domain = (from ?? '').match(/@([a-z0-9.-]+\.[a-z]{2,})/i);
  if (domain) {
    const host = domain[1].split('.')[0];
    if (host && !/gmail|google|outlook|yahoo|libertygroupfunding/i.test(host)) {
      return host.charAt(0).toUpperCase() + host.slice(1);
    }
  }

  return null;
}

function buildConditionProperties({
  conditionText,
  loanPageId,
  needsReview = false,
  borrowerLastName = null,
  lenderName = null,
  source = 'Underwriter'
}) {
  const props = {
    Condition:  { title: [{ text: { content: conditionText } }] },
    Status:     { select: { name: needsReview ? 'In Progress' : 'Open' } },
    Source:     { select: { name: source } },
    'Date Added': { date: { start: new Date().toISOString().split('T')[0] } }
  };

  if (loanPageId) props.Loan = { relation: [{ id: loanPageId }] };
  if (borrowerLastName) {
    props[BORROWER_LAST_NAME_PROPERTY] = { rich_text: [{ text: { content: borrowerLastName } }] };
  }
  if (lenderName) {
    props[LENDER_PROPERTY] = { rich_text: [{ text: { content: lenderName } }] };
  }

  return props;
}

module.exports = {
  extractBorrowerLastName,
  detectLenderName,
  buildConditionProperties
};
