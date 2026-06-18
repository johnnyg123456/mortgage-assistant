function normalizePdfText(text) {
  return text.replace(/\u00ad/g, '').replace(/­/g, '').replace(/\u00a0/g, ' ');
}

function formatConditionTitle({ code, text }) {
  return code ? `${code} | ${text}` : text;
}

function parseBorrowerLastFirst(normalized, label) {
  const m = normalized.match(new RegExp(`${label}:\\s*([A-Za-z]+),\\s*([A-Za-z]+)`, 'i'));
  if (!m) return null;
  return `${m[2].trim()} ${m[1].trim()}`;
}

function extractNumberedConditions(block, sectionName) {
  const conditions = [];
  const parts = block.split(/(?=\d+\s*[\.\)])/);

  for (const part of parts) {
    const m = part.match(/^(\d+)\s*[\.\)]\s*([\s\S]+)/);
    if (!m) continue;

    const text = m[2]
      .replace(/\*{2,}[\s\S]*?\*{2,}/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (text.length < 10) continue;

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

function extractSectionBlock(normalized, startRe, stopRes) {
  const startMatch = normalized.match(startRe);
  if (!startMatch) return '';

  const startIdx = startMatch.index + startMatch[0].length;
  const rest = normalized.slice(startIdx);
  let endIdx = rest.length;

  for (const stopRe of stopRes) {
    const stopMatch = rest.match(stopRe);
    if (stopMatch && stopMatch.index < endIdx) endIdx = stopMatch.index;
  }

  return rest.slice(0, endIdx);
}

module.exports = {
  normalizePdfText,
  formatConditionTitle,
  parseBorrowerLastFirst,
  extractNumberedConditions,
  extractSectionBlock
};
