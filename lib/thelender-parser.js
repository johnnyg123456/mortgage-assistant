const { normalizePdfText, formatConditionTitle, extractSectionBlock } = require('./pdf-text-utils');

function parseThelenderApprovalLetter(text) {
  const normalized = normalizePdfText(text);
  if (!/thelender\.com|Loan Approval as of/i.test(normalized)) return null;
  if (!/Loan\s*#:\s*\d+/i.test(normalized)) return null;

  const loan_number = normalized.match(/Loan\s*#:\s*(\d+)/i)?.[1] ?? null;

  let borrower_name = null;
  const b1 = normalized.match(/Borrower 1 Name:\s*([A-Za-z]+)\s+([A-Za-z]+)(?:\s+([A-Za-z]+))?(?=Borrower|\s*Co-Borrower)/i);
  if (b1) {
    const last = b1[1].trim();
    const first = b1[2].trim();
    const mid = b1[3]?.trim();
    borrower_name = mid ? `${first} ${mid} ${last}` : `${first} ${last}`;
  }

  const condStart = normalized.search(/Prior to (?:Approval|Docs|Funding)/i);
  if (condStart === -1) return null;

  let block = normalized.slice(condStart);
  const footer = block.search(/For all price related questions/i);
  if (footer !== -1) block = block.slice(0, footer);

  const conditions = [];
  const parts = block.split(/(?=\d+\.)/);

  for (const part of parts) {
    const m = part.match(/^(\d+)\.([\s\S]+)/);
    if (!m) continue;
    const text = m[2].replace(/\s+/g, ' ').trim();
    if (text.length < 5) continue;

    conditions.push({
      code:         'PTD',
      category:     'Prior to Docs',
      section:      'Prior to Docs',
      text:         formatConditionTitle({ code: 'PTD', text: text.slice(0, 500) }),
      needs_review: false
    });
  }

  if (!conditions.length) return null;
  return { borrower_name, loan_number, conditions };
}

module.exports = { parseThelenderApprovalLetter };
