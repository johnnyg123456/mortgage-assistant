const {
  normalizePdfText,
  parseBorrowerLastFirst,
  extractNumberedConditions,
  extractSectionBlock
} = require('./pdf-text-utils');

function parseTheloanstoreApprovalLetter(text) {
  const normalized = normalizePdfText(text);
  if (!/Underwriting Conditional Approval/i.test(normalized)) return null;
  if (!/The Loan Store|uwdept@theloanstore/i.test(normalized)) return null;

  const loan_number = normalized.match(/Loan\s*#:\s*(\d+)/i)?.[1] ?? null;
  const borrower_name = parseBorrowerLastFirst(normalized, 'Borrower');

  const Q = '[\u201c\u201d"\']?';
  const sections = [
    { start: new RegExp(`Prior to Approval\\s*\\(\\s*${Q}PTA${Q}\\s*\\)\\s*Conditions`, 'i'), name: 'PTA' },
    { start: new RegExp(`Prior to Closing Disclosure\\s*\\(\\s*${Q}PTCD${Q}\\s*\\)\\s*Conditions`, 'i'), name: 'PTCD' },
    { start: new RegExp(`Prior to Docs\\s*\\(\\s*${Q}PTD${Q}\\s*\\)\\s*Conditions`, 'i'), name: 'PTD' }
  ];

  const conditions = [];
  const stopRes = [/Prior to Approval/i, /Prior to Closing Disclosure/i, /Prior to Docs/i, /Prior to Funding/i];

  for (let i = 0; i < sections.length; i++) {
    const { start, name } = sections[i];
    const laterStarts = sections.slice(i + 1).map(s => s.start);
    const block = extractSectionBlock(normalized, start, [...laterStarts, /Prior to Funding/i]);
    conditions.push(...extractNumberedConditions(block, name));
  }

  if (!conditions.length) return null;
  return { borrower_name, loan_number, conditions };
}

module.exports = { parseTheloanstoreApprovalLetter };
