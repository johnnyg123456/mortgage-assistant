function normalizePdfText(text) {
  return text.replace(/\u00ad/g, '').replace(/­/g, '').replace(/\u00a0/g, ' ');
}

function formatConditionTitle({ code, text }) {
  return code ? `${code} | ${text}` : text;
}

function parseBorrowerName(normalized) {
  const m = normalized.match(/([A-Z][a-z]+ [A-Z][a-z]+)\s+West Palm Beach,\s*FL/i);
  if (m) return m[1].trim();
  return null;
}

function parseLoanNumber(normalized) {
  return normalized.match(/(\d{6,8})\s*\nInitial Approval:/i)?.[1] ?? null;
}

const PTF_CODES = new Set(['4625', '6021', '8001', '8009', '8010', '8300']);

function isAcraConditionCode(code) {
  if (PTF_CODES.has(code)) return false;
  const n = parseInt(code, 10);
  if (n >= 15000 && n <= 16999) return true;
  if (n >= 5000 && n <= 5999) return true;
  if (n >= 2000 && n <= 4999) return true;
  return false;
}

function parseConditionLine(line) {
  const withDate = line.match(/^(\d{4,5})(\d{2}\/\d{2}\/\d{4})([\s\S]*)$/);
  if (withDate && isAcraConditionCode(withDate[1])) {
    return {
      code:        withDate[1],
      clearedDate: withDate[2],
      text:        withDate[3].trim()
    };
  }

  const noDate = line.match(/^(\d{4,5})([\s\S]+)$/);
  if (noDate && isAcraConditionCode(noDate[1])) {
    return {
      code:        noDate[1],
      clearedDate: null,
      text:        noDate[2].trim()
    };
  }

  return null;
}

function expandEmbeddedCodes(line) {
  const re = /\b(\d{4,5})(?=[A-Za-z])/g;
  const matches = [...line.matchAll(re)].filter(m => isAcraConditionCode(m[1]));
  if (matches.length <= 1) return [line];

  const parts = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : line.length;
    parts.push(line.slice(start, end).trim());
  }

  const prefix = line.slice(0, matches[0].index).trim();
  if (prefix) {
    parts[0] = `${prefix} ${parts[0]}`.replace(/\s+/g, ' ').trim();
  }

  return parts.filter(Boolean);
}

function isNoiseLine(line) {
  return !line ||
    /^Page \d+/i.test(line) ||
    /^Underwriter Signature/i.test(line) ||
    /^Condition$/i.test(line) ||
    /^PRIOR TO (DOC|FUND)$/i.test(line) ||
    /^Cleared Date$/i.test(line) ||
    /^REQUIRED DEBT$/i.test(line) ||
    /^Creditor/i.test(line) ||
    /^Sr\. Mgmt Signature/i.test(line);
}

function extractPtdBody(normalized) {
  const start = normalized.search(/^\d{4,5}[A-Za-z]/m);
  const end = normalized.search(/\n6021[A-Za-z]/i);
  if (start === -1) return '';

  let body = normalized.slice(start, end === -1 ? undefined : end);
  body = body.replace(/PRIOR TO FUND[\s\S]*?(?=\n470\d)/i, '');
  return body;
}

function parseAcraConditions(normalized) {
  const body = extractPtdBody(normalized);
  const lines = body.split('\n');

  const parsed = [];
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (isNoiseLine(line)) continue;

    for (const subline of expandEmbeddedCodes(line)) {
      const hit = parseConditionLine(subline);
      if (hit) {
        if (current) parsed.push(current);
        current = hit;
        continue;
      }

      if (current) {
        current.text = `${current.text} ${subline}`.replace(/\s+/g, ' ').trim();
      }
    }
  }

  if (current) parsed.push(current);

  return parsed.map(({ code, clearedDate, text }) => {
    const detail = text.replace(/^\d+\s*\|\s*/, '').slice(0, 500);
    return {
      code,
      category:     'PTD',
      section:      'Prior to Doc',
      cleared:      !!clearedDate,
      cleared_date: clearedDate,
      text:         formatConditionTitle({ code: 'PTD', text: detail }),
      needs_review: false
    };
  });
}

function parseAcraApprovalLetter(text) {
  const normalized = normalizePdfText(text);
  if (!/Acra Lending|Conditional Loan Approval/i.test(normalized)) return null;
  if (!/PRIOR TO DOC/i.test(normalized)) return null;

  const loan_number = parseLoanNumber(normalized);
  const borrower_name = parseBorrowerName(normalized);
  const all = parseAcraConditions(normalized);
  const conditions = all.filter(c => !c.cleared);
  const cleared_conditions = all.filter(c => c.cleared);

  if (!all.length) return null;

  return { borrower_name, loan_number, conditions, cleared_conditions };
}

module.exports = { parseAcraApprovalLetter };
