const { normalizePdfText, formatConditionTitle } = require('./pdf-text-utils');

function parseArcTableConditions(block, sectionName) {
  const conditions = [];
  const re = /(?:^|\n)(\d{1,3})([A-Za-z][\s\S]*?)(?=(?:\n\d{1,3}[A-Za-z])|CategoryID|$)/g;
  let m;

  while ((m = re.exec(block)) !== null) {
    const text = m[2].replace(/\s+/g, ' ').trim();
    if (text.length < 15) continue;
    if (/^ConditionsCondition Status/i.test(text)) continue;

    conditions.push({
      code:         m[1],
      category:     sectionName,
      section:      sectionName,
      text:         formatConditionTitle({ code: m[1], text: text.slice(0, 500) }),
      needs_review: false
    });
  }

  return conditions;
}

function parseArcApprovalLetter(text) {
  const normalized = normalizePdfText(text);
  if (!/APPROVAL CERTIFICATE/i.test(normalized)) return null;
  if (!/Arc Home/i.test(normalized)) return null;

  const loan_number = normalized.match(/Loan\s*#:?\s*(\d+)/i)?.[1]
    ?? normalized.match(/Loan Number\s*(\d+)/i)?.[1]
    ?? null;

  const borrower_name = normalized.match(/APPROVAL CERTIFICATE\s*\n([A-Za-z]+(?:\s+[A-Za-z]+)?)\s*\nCredit Exp/i)?.[1]?.trim()
    ?? normalized.match(/APPROVAL CERTIFICATE\s+([A-Za-z]+(?:\s+[A-Za-z]+)?)\s+Credit Exp/i)?.[1]?.trim()
    ?? null;

  const sections = [
    { re: /PRIOR TO DOCS\s*ORDERED/i, name: 'Prior to Docs Ordered' },
    { re: /PRIOR TO DOCS DRAWN/i, name: 'Prior to Docs Drawn' },
    { re: /AT CLOSING/i, name: 'At Closing' }
  ];

  const conditions = [];
  for (let i = 0; i < sections.length; i++) {
    const { re, name } = sections[i];
    const startMatch = normalized.match(re);
    if (!startMatch) continue;

    const startIdx = startMatch.index + startMatch[0].length;
    const rest = normalized.slice(startIdx);
    let endIdx = rest.length;

    for (let j = i + 1; j < sections.length; j++) {
      const next = rest.match(sections[j].re);
      if (next && next.index < endIdx) endIdx = next.index;
    }

    const ptf = rest.match(/PRIOR TO FUND/i);
    if (ptf && ptf.index < endIdx) endIdx = ptf.index;

    conditions.push(...parseArcTableConditions(rest.slice(0, endIdx), name));
  }

  if (!conditions.length) return null;
  return { borrower_name, loan_number, conditions };
}

module.exports = { parseArcApprovalLetter };
