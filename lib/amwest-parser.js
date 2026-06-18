const { normalizePdfText, formatConditionTitle } = require('./pdf-text-utils');

function parseAmwestApprovalLetter(text) {
  const normalized = normalizePdfText(text);
  if (!/AmWest|amwestfunding/i.test(normalized)) return null;
  if (!/PRIOR TO DOCS CONDITIONS/i.test(normalized)) return null;

  const loan_number = normalized.match(/Loan Number:\s*(\d{8,})/i)?.[1]
    ?? normalized.match(/\n(\d{10})\n(?:Christina|John)\s/i)?.[1]
    ?? null;

  const borrower_name = normalized.match(/\n([A-Za-z]+\s+[A-Za-z]+)\s*\n[A-Za-z]+,\s*[A-Z]{2}\s+\d{5}/)?.[1]?.trim()
    ?? null;

  const start = normalized.search(/PRIOR TO DOCS CONDITIONS/i);
  if (start === -1) return null;

  const afterPtd = normalized.slice(start);
  const endInBlock = afterPtd.search(/PRIOR TO FUNDING CONDITIONS/i);
  const block = endInBlock !== -1 ? afterPtd.slice(0, endInBlock) : afterPtd;
  const conditions = [];

  const re = /(\d{5})([A-Za-z][\s\S]*?)(?=\d{5}[A-Za-z]|Page \d+ of \d+|$)/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    let body = m[2].replace(/#\{[^}]*\}#/g, ' ').replace(/\s+/g, ' ').trim();
    const category = body.match(/^([A-Za-z]+)/)?.[1] ?? 'PTD';
    body = body.replace(/^\d+\.\s*/, '').trim();
    if (body.length < 10) continue;

    conditions.push({
      code:         m[1],
      category:     category,
      section:      'Prior to Docs',
      text:         formatConditionTitle({ code: m[1], text: body.slice(0, 500) }),
      needs_review: false
    });
  }

  if (!conditions.length) return null;
  return { borrower_name, loan_number, conditions };
}

module.exports = { parseAmwestApprovalLetter };
