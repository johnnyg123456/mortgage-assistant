const {
  normalizePdfText,
  formatConditionTitle,
  extractSectionBlock
} = require('./pdf-text-utils');

function parseCakeConditions(block, sectionName) {
  const conditions = [];
  const parts = block.split(/(?=\d+\))/);

  for (const part of parts) {
    const m = part.match(/^(\d+)\)\s*([\s\S]+)/);
    if (!m) continue;

    const raw = m[2].replace(/\s+/g, ' ').trim();
    if (raw.length < 10) continue;

    const catMatch = raw.match(/^([^-]+)\s*-\s*(.+)$/);
    const text = catMatch
      ? `${catMatch[1].trim()} - ${catMatch[2].trim()}`
      : raw;

    conditions.push({
      code:         sectionName.replace(/\s+/g, ''),
      category:     sectionName,
      section:      sectionName,
      text:         formatConditionTitle({ code: sectionName, text: text.slice(0, 500) }),
      needs_review: false
    });
  }

  return conditions;
}

function parseCakeApprovalLetter(text) {
  const normalized = normalizePdfText(text);
  if (!/Cake Mortgage Corp/i.test(normalized)) return null;
  if (!/CONDITIONAL LOAN APPROVAL/i.test(normalized)) return null;

  const loan_number = normalized.match(/Loan:\s*(\d+)/i)?.[1] ?? null;
  const borrower_name = normalized.match(/Primary Borrower:\s*([A-Za-z]+(?:\s+[A-Za-z]+)*?)(?=\s*Credit Scores)/i)?.[1]?.trim() ?? null;

  const ptdBlock = extractSectionBlock(
    normalized,
    /Prior to Doc\/Approval Conditions/i,
    [/Prior to Funding Conditions/i]
  );
  const fundingBlock = extractSectionBlock(
    normalized,
    /Prior to Funding Conditions/i,
    [/Prior to Close/i, /Page \d+/i]
  );

  const conditions = [
    ...parseCakeConditions(ptdBlock, 'Prior to Doc'),
    ...parseCakeConditions(fundingBlock, 'Prior to Doc')
  ];

  if (!conditions.length) return null;
  return { borrower_name, loan_number, conditions };
}

module.exports = { parseCakeApprovalLetter };
