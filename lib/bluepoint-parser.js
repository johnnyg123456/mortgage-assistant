const { normalizePdfText, formatConditionTitle } = require('./pdf-text-utils');

function parseBluepointApprovalLetter(text) {
  const normalized = normalizePdfText(text);
  if (!/APPROVAL CERTIFICATE/i.test(normalized)) return null;
  if (!/BluePoint|Royal Pacific Funding|bluepointmtg/i.test(normalized)) return null;

  const loan_number = normalized.match(/Loan Number\s*(\d+)/i)?.[1] ?? null;

  const borrower_name = normalized.match(/\n([A-Za-z]+(?:\s+[A-Za-z-]+)?)\s*\n\d+[^\n]*\n(?:Miami|Fort Lauderdale|Plantation)/i)?.[1]?.trim()
    ?? null;

  const start = normalized.search(/LOAN APPROVED FOR|^\*{3,}/m);
  const end = normalized.search(/\*PTD|WARNINGDATE CLEARED/i);
  if (start === -1) return null;

  const block = normalized.slice(start, end === -1 ? start + 4000 : end);
  const lines = block.split('\n').map(l => l.trim()).filter(Boolean);

  const conditions = [];
  let current = '';

  for (const line of lines) {
    if (/^LOAN APPROVED FOR/i.test(line)) continue;
    if (/^\*{2,}$/.test(line)) continue;
    if (/^TURN TIMES/i.test(line)) continue;
    if (/^TPO COMPANY IS DUE/i.test(line)) continue;
    if (/^https?:\/\//i.test(line)) continue;
    if (/^Approval Letter$/i.test(line)) continue;
    if (line.length < 20) continue;

    if (/^[A-Z][A-Z\s\-]+:/.test(line) && current) {
      conditions.push(current);
      current = line;
    } else if (/^\d+\.\s/.test(line)) {
      if (current) conditions.push(current);
      current = line.replace(/^\d+\.\s*/, '');
    } else {
      current = current ? `${current} ${line}` : line;
    }
  }
  if (current) conditions.push(current);

  const mapped = conditions
    .map(t => t.replace(/\s+/g, ' ').trim())
    .filter(t => t.length > 20)
    .map((t, i) => ({
      code:         'PTD',
      category:     'Prior to Docs',
      section:      'Prior to Docs',
      text:         formatConditionTitle({ code: 'PTD', text: t.slice(0, 500) }),
      needs_review: false
    }));

  if (!mapped.length) return null;
  return { borrower_name, loan_number, conditions: mapped };
}

module.exports = { parseBluepointApprovalLetter };
