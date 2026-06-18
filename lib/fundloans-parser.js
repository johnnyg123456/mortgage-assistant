const { normalizePdfText, formatConditionTitle } = require('./pdf-text-utils');

function parseFundloansApprovalLetter(text) {
  const normalized = normalizePdfText(text);
  if (!/FundLoans/i.test(normalized)) return null;
  if (!/Conditional Loan Approval/i.test(normalized)) return null;

  const loan_number = normalized.match(/Loan\s*#\s*(\d+)/i)?.[1] ?? null;
  const borrower_name = normalized.match(/Borrower:([A-Za-z]+),\s*([A-Za-z]+)/i)
    ? `${normalized.match(/Borrower:([A-Za-z]+),\s*([A-Za-z]+)/i)[2].trim()} ${normalized.match(/Borrower:([A-Za-z]+),\s*([A-Za-z]+)/i)[1].trim()}`
    : null;

  const start = normalized.search(/PRIOR TO DOCS/i);
  const end = normalized.search(/PRIOR TO FUNDING|POST FUNDING/i);
  if (start === -1) return null;

  const block = normalized.slice(start, end === -1 ? undefined : end);
  const conditions = [];
  const re = /([A-Z]\d{2,3})\s*-\s*([\s\S]*?)(?=[A-Z]\d{2,3}\s*-|-{20,}|$)/g;
  let m;

  while ((m = re.exec(block)) !== null) {
    const text = m[2].replace(/-{10,}/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length < 15) continue;

    conditions.push({
      code:         m[1],
      category:     m[1].charAt(0),
      section:      'Prior to Docs',
      text:         formatConditionTitle({ code: m[1], text: text.slice(0, 500) }),
      needs_review: false
    });
  }

  if (!conditions.length) return null;
  return { borrower_name, loan_number, conditions };
}

module.exports = { parseFundloansApprovalLetter };
