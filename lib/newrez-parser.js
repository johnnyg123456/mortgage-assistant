function normalizePdfText(text) {
  return text.replace(/\u00ad/g, '').replace(/­/g, '').replace(/\u00a0/g, ' ');
}

function formatConditionTitle({ code, text }) {
  return code ? `${code} | ${text}` : text;
}

function parseBorrowerName(normalized) {
  const m = normalized.match(/Primary Borrower:\s*([A-Za-z]+),\s*([A-Za-z]+)/i);
  if (!m) return null;
  return `${m[2].trim()} ${m[1].trim()}`;
}

function parseLoanNumber(normalized) {
  return normalized.match(/Loan\s*#:\s*(\d+)/i)?.[1] ?? null;
}

const NARRATIVE_STARTS = [
  'Provide unexpired Master HOA',
  'Limited/Streamline condo review',
  'All 3rd party invoices',
  'Condition Update',
  'Acceptable Preliminary Title',
  'Address for the Settlement Agent',
  'Confirm Settlement Agent email',
  'Provide copy of HO6',
  'Provide tax sheet',
  'NewRez to obtain a third party appraisal',
  'Newrez to obtain a third party appraisal',
  'Provide legal residency',
  'Borrower to provide a copy of fully executed purchase contract',
  'Provide most recent 12 months consecutive bank statements',
  'Borrower to provide fully executed letter from business CPA',
  'Borrower to provide a copy of the cancelled earnest money check',
  'Borrower to provide most recent 2 months bank statements',
  'Provide written verification of rent',
  'Third party sources indicates',
  'A survey is required',
  'Provide borrower executed Anti-Coercion',
  'Each borrower to provide a valid acceptable form of identification',
  'Self Employed income used to qualify'
];

const HEADER_CUT_PATTERNS = [
  /\sLoan\s*#:\s*\d+/i,
  /\sPrimary Borrower:/i,
  /\sUpload Conditions on our Blueprint/i,
  /\sBorrowers and Subject Property/i,
  /\sGeneral Loan Information/i,
  /\sRate Lock Information/i,
  /\sImportant Dates\s+\d/i,
  /\sDetails of Transaction/i,
  /\sConnect Direct to our Brigade/i,
  /\sPartner:\s*Liberty Group/i,
  /\sOrig(?:inator)?:\s*Phone:/i
];

function trimNarrativeTail(text) {
  let cut = text.length;
  for (const re of HEADER_CUT_PATTERNS) {
    const m = re.exec(text);
    if (m && m.index > 20 && m.index < cut) cut = m.index;
  }
  return text.slice(0, cut).replace(/\s+/g, ' ').trim();
}

function cleanNarrativeBlock(block) {
  return block
    .replace(/TO CLEAR\s*#\s*PTA[^\n]*/gi, ' ')
    .replace(/TO CLEAR\s*#\s*PTCD[^\n]*/gi, ' ')
    .replace(/TO CLEAR\s*#\s*PTD[^\n]*/gi, ' ')
    .replace(/Approval Exp\.:[^\n]*/gi, ' ')
    .replace(/Income Doc Exp\.:[^\n]*/gi, ' ')
    .replace(/Assets Doc Exp\.:[^\n]*/gi, ' ')
    .replace(/Page \d+ of \d+/gi, ' ')
    .replace(/CONDITIONAL LOAN APPROVAL/gi, ' ')
    .replace(/\bPA\s*\d+\b/gi, ' ')
    .replace(/\b(CRM|TS|HOS|UW|VS|CF)\s*\d+(?:\.\d+)?\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitCombinedNarratives(narratives) {
  const out = [];
  for (const raw of narratives) {
    const text = trimNarrativeTail(raw);
    if (!text || text.length < 15) continue;

    const cdaIdx = text.search(/NewRez to obtain a third party appraisal/i);
    const taxIdx = text.search(/Provide tax sheet for subject property/i);
    if (taxIdx !== -1 && cdaIdx !== -1 && cdaIdx > taxIdx) {
      const taxPart = trimNarrativeTail(text.slice(0, cdaIdx));
      const cdaPart = trimNarrativeTail(text.slice(cdaIdx));
      if (taxPart.length > 15) out.push(taxPart);
      if (cdaPart.length > 15) out.push(cdaPart);
      continue;
    }

    if (text.length > 600) {
      const inner = splitNarratives(text, true);
      if (inner.length > 1) {
        out.push(...inner);
        continue;
      }
    }

    out.push(text);
  }
  return out;
}

function splitNarratives(block, isResplit = false) {
  const text = cleanNarrativeBlock(block);
  const hits = [];

  for (const start of NARRATIVE_STARTS) {
    let idx = 0;
    while ((idx = text.indexOf(start, idx)) !== -1) {
      hits.push({ idx, start });
      idx += start.length;
    }
  }

  hits.sort((a, b) => a.idx - b.idx || b.start.length - a.start.length);

  const deduped = [];
  for (const hit of hits) {
    if (deduped.some(d => Math.abs(d.idx - hit.idx) < 5)) continue;
    deduped.push(hit);
  }

  const narratives = [];
  for (let i = 0; i < deduped.length; i++) {
    const from = deduped[i].idx;
    const to = i + 1 < deduped.length ? deduped[i + 1].idx : text.length;
    const chunk = trimNarrativeTail(text.slice(from, to));
    if (chunk.length > 15) narratives.push(chunk);
  }

  if (isResplit) return narratives;
  return splitCombinedNarratives(narratives);
}

function mapNarratives(narratives, category, section) {
  return narratives.map(text => ({
    code:         category,
    category,
    section,
    text:         formatConditionTitle({ code: category, text }),
    needs_review: false
  }));
}

function parseNewrezApprovalLetter(text) {
  const normalized = normalizePdfText(text);
  if (!/CONDITIONAL LOAN APPROVAL/i.test(normalized)) return null;
  if (!/TO CLEAR\s*#\s*PTA\s*-\s*Prior to Approval/i.test(normalized)) return null;

  const loan_number = parseLoanNumber(normalized);
  const borrower_name = parseBorrowerName(normalized);
  if (!loan_number) return null;

  const ptaHeaderIdx = normalized.search(/TO CLEAR\s*#\s*PTA\s*-\s*Prior to Approval/i);
  const ptcdHeaderIdx = normalized.search(/TO CLEAR\s*#\s*PTCD\s*-\s*Prior to Closing Disclosure/i);

  const ptaStart = normalized.search(/Provide unexpired Master HOA|Limited\/Streamline condo review/i);
  const ptaBlock = ptaStart !== -1 && ptaHeaderIdx !== -1
    ? normalized.slice(ptaStart, ptaHeaderIdx)
    : null;

  const middleStart = normalized.search(/All 3rd party invoices/i);
  const middleEnd = ptcdHeaderIdx !== -1 ? ptcdHeaderIdx : normalized.length;
  const middleBlock = middleStart !== -1 ? normalized.slice(middleStart, middleEnd) : '';

  const ptdSplit = middleBlock.search(/Provide tax sheet for subject property/i);
  const ptcdBlock = ptdSplit !== -1 ? middleBlock.slice(0, ptdSplit) : middleBlock;

  let ptdBlock = ptdSplit !== -1 ? middleBlock.slice(ptdSplit) : '';
  const ptdEnd = ptdBlock.search(/Settlement Agent \(SA\) to provide tracking/i);
  if (ptdEnd !== -1) ptdBlock = ptdBlock.slice(0, ptdEnd);

  const conditions = [];

  if (ptaBlock) {
    conditions.push(...mapNarratives(
      splitNarratives(ptaBlock),
      'PTA',
      'Prior to Approval'
    ));
  }

  if (ptcdBlock) {
    conditions.push(...mapNarratives(
      splitNarratives(ptcdBlock),
      'PTCD',
      'Prior to Closing Disclosure'
    ));
  }

  if (ptdBlock) {
    conditions.push(...mapNarratives(
      splitNarratives(ptdBlock),
      'PTD',
      'Prior to Docs'
    ));
  }

  if (!conditions.length) return null;

  return { borrower_name, loan_number, conditions };
}

module.exports = {
  parseNewrezApprovalLetter,
  normalizePdfText,
  trimNarrativeTail,
  splitNarratives
};
