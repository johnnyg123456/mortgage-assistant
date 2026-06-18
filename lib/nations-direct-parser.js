function normalizePdfText(text) {
  return text.replace(/\u00ad/g, '').replace(/­/g, '').replace(/\u00a0/g, ' ');
}

function formatConditionTitle({ code, text }) {
  return code ? `${code} | ${text}` : text;
}

function parseLoanNumber(normalized) {
  return normalized.match(/Loan\s*#:\s*(\d+)/i)?.[1] ?? null;
}

function parseBorrowerName(normalized) {
  const m = normalized.match(/Borrower:\s*([A-Za-z]+,\s*[A-Za-z]+)/i);
  if (!m) return null;
  const [last, first] = m[1].split(',').map(s => s.trim());
  return `${first} ${last}`;
}

function parseNationsDirectConditions(normalized) {
  const start = normalized.search(/Prior To Approval/i);
  if (start === -1) return [];

  let body = normalized.slice(start);
  const ptfIdx = body.search(/Prior To Funding/i);
  if (ptfIdx !== -1) body = body.slice(0, ptfIdx);

  const internalIdx = body.search(/Internal Conditions/i);
  if (internalIdx !== -1) body = body.slice(0, internalIdx);

  const priorPurchaseIdx = body.search(/Prior To Purchase/i);
  if (priorPurchaseIdx !== -1) body = body.slice(0, priorPurchaseIdx);

  const conditions = [];
  const re = /([A-Z]\d+[a-z]?):\s*([\s\S]*?)(?=(?:[A-Z]\d+[a-z]?:)|(?:-{10,})|$)/gi;
  let m;
  while ((m = re.exec(body)) !== null) {
    const code = m[1].toUpperCase();
    const text = m[2].replace(/\s+/g, ' ').trim();
    if (text.length < 5) continue;
    conditions.push({
      code,
      category: null,
      section: 'Prior to Approval / Docs',
      text: formatConditionTitle({ code, text: text.slice(0, 500) }),
      needs_review: false
    });
  }

  return dedupeByCode(conditions);
}

function dedupeByCode(conditions) {
  const seen = new Set();
  return conditions.filter(c => {
    const key = `${c.code}|${c.text.slice(0, 40)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseNationsDirectApproval(text) {
  const normalized = normalizePdfText(text);
  if (!/Nations Direct|Conditional Loan Approval for/i.test(normalized)) return null;
  if (!/Prior To Approval/i.test(normalized)) return null;

  const loan_number = parseLoanNumber(normalized);
  const borrower_name = parseBorrowerName(normalized);
  const conditions = parseNationsDirectConditions(normalized);
  if (!conditions.length) return null;

  return { borrower_name, loan_number, conditions };
}

module.exports = { parseNationsDirectApproval };
