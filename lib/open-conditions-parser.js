const {
  normalizePdfText,
  extractNumberedConditions,
  extractSectionBlock
} = require('./pdf-text-utils');

// Emporium TPO and ResiCentral share the "Conditional Approval / Open Conditions" format.
function parseOpenConditionsApproval(text) {
  const normalized = normalizePdfText(text);
  if (!/Conditional Approval/i.test(normalized)) return null;
  if (!/Open(?:\s+Outstanding)?\s+Conditions/i.test(normalized)) return null;
  if (!/Loan\s*#\s*\d+/i.test(normalized)) return null;

  const loan_number = normalized.match(/Loan\s*#\s*(\d+)/i)?.[1] ?? null;

  let borrower_name = normalized.match(/Borrower:\s*([A-Za-z]+(?:\s+[A-Za-z]+)?)\s*Borr Credit/i)?.[1]?.trim();
  if (!borrower_name) {
    borrower_name = normalized.match(/Borrower:([A-Za-z]+\s+[A-Za-z]+)Borrower:/i)?.[1]?.trim();
  }

  const sections = [
    { start: /Prior to Approval/i, name: 'Prior to Approval', stop: [/Prior to Docs/i, /Prior to Closing/i, /Prior to Funding/i] },
    { start: /Prior to Docs/i, name: 'Prior to Docs', stop: [/Prior to Closing/i, /Prior to Funding/i, /Prior to Close/i] },
    { start: /Prior to Closing/i, name: 'Prior to Closing', stop: [/Prior to Funding/i, /Prior to Close/i] }
  ];

  const conditions = [];
  for (const { start, name, stop } of sections) {
    const block = extractSectionBlock(normalized, start, stop);
    conditions.push(...extractNumberedConditions(block, name));
  }

  if (!conditions.length) return null;
  return { borrower_name, loan_number, conditions };
}

module.exports = { parseOpenConditionsApproval };
