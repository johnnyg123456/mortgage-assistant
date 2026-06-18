const { normalizePdfText, formatConditionTitle } = require('./pdf-text-utils');

function parseOrionApprovalLetter(text) {
  const normalized = normalizePdfText(text);
  if (!/Orion Lending|orionlending/i.test(normalized)) return null;
  if (!/Loan Decision/i.test(normalized)) return null;

  const loan_number = normalized.match(/XXXXXX(\d+)/i)?.[1]
    ?? normalized.match(/Loan Number:\s*(\d+)/i)?.[1]
    ?? null;

  const borrower_name = normalized.match(/\n([A-Za-z]+\s+[A-Za-z]+)\s*\nInvestment/i)?.[1]?.trim()
    ?? normalized.match(/Borrowers[\s\S]*?([A-Za-z]+\s+[A-Za-z]+)\s+Investment/i)?.[1]?.trim()
    ?? null;

  const start = normalized.search(/Prior To Clear To Close/i);
  if (start === -1) return null;

  const block = normalized.slice(start);
  const conditions = [];
  const re = /([A-Z]{2,4}\d{2,3})(?:Needed[\d\/]+)?([\s\S]*?)(?=[A-Z]{2,4}\d{2,3}|Conditions must be received|$)/g;
  let m;

  while ((m = re.exec(block)) !== null) {
    const text = m[2].replace(/\s+/g, ' ').trim();
    if (text.length < 20) continue;
    if (/Reviewer#StatusDateDescription/i.test(text)) continue;

    conditions.push({
      code:         m[1],
      category:     'Prior to CTC',
      section:      'Prior To Clear To Close',
      text:         formatConditionTitle({ code: m[1], text: text.slice(0, 500) }),
      needs_review: false
    });
  }

  if (!conditions.length) return null;
  return { borrower_name, loan_number, conditions };
}

module.exports = { parseOrionApprovalLetter };
