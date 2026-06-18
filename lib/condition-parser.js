require('dotenv').config();
const pdfParse = require('pdf-parse');
const Anthropic = require('@anthropic-ai/sdk');
const { queryDatabase, createPage, updatePage } = require('./notion-client');
const { findLoanByNumberOrBorrower, findOrCreateLoanFromApproval, loanNumbersMatch, getLoanNumberFromPage, finalizeClearToCloseLoan } = require('./loan-service');
const {
  extractBorrowerLastName,
  detectLenderName,
  buildConditionProperties
} = require('./condition-fields');
const { sendSyncNotification } = require('./send-email');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CONDITIONS_DB = process.env.NOTION_CONDITIONS_DB_ID;
const { looksLikeApprovalLetter } = require('./approval-letter');

function log(action, detail) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), handler: 'condition-parser', action, ...detail }));
}

async function extractPdfText(pdfBuffer) {
  const result = await pdfParse(pdfBuffer);
  return result.text;
}

function extractFromSubject(subject) {
  const uwm = subject.match(/^(\d{6,})\s*[-–]\s*(.+)$/);
  if (uwm) return { loan_number: uwm[1], borrower_name: uwm[2].trim() };

  const newrez = subject.match(/approval for loan\s*#?\s*(\d+)/i);
  if (newrez) return { loan_number: newrez[1] };

  const internalPdf = subject.match(/loan approval pdf\s+(.+)/i);
  if (internalPdf) {
    return {
      borrower_name: internalPdf[1]
        .replace(/^(re:\s*)+/i, '')
        .replace(/\s*(family)?\s*loan$/i, '')
        .trim()
    };
  }

  return {};
}

function extractFromFilename(filename) {
  const base = (filename ?? '').replace(/\.pdf$/i, '').trim();
  if (!base || base.length < 2) return {};
  if (/approval|letter|1003|1008|closing|disclosure|intro/i.test(base)) return {};
  return { borrower_name: base.replace(/[_-]/g, ' ') };
}

function formatConditionTitle({ code, category, text }) {
  const desc = (category && !text.startsWith(category))
    ? `${category}: ${text}`
    : text;
  return code ? `${code} | ${desc}` : desc;
}

const PTF_SECTION_RE = /prior\s+to\s+funding(\s+conditions)?|\(ptf\)|\bptf\b/i;

// AmWest PRIOR TO FUNDING CONDITIONS page — known PTF-only condition codes
const AMWEST_PTF_CODES = new Set(['99', '71', '74', '1202', '1387']);

function isPtfSection(section) {
  return !!(section && PTF_SECTION_RE.test(section));
}

function stripPtfBlockFromText(text) {
  const normalized = normalizePdfText(text);
  const startMatch = normalized.match(/prior\s+to\s+funding\s+conditions/i);
  if (!startMatch) return normalized;

  const startIdx = startMatch.index;
  const afterStart = startIdx + startMatch[0].length;
  const rest = normalized.slice(afterStart);
  const endMatch = rest.match(
    /(?:post\s+funding\s+conditions|prior\s+to\s+disbursement\s+conditions|prior\s+to\s+documentation)/i
  );
  const endIdx = endMatch ? afterStart + endMatch.index : normalized.length;
  log('ptf-block-stripped', { chars: endIdx - startIdx });
  return normalized.slice(0, startIdx) + normalized.slice(endIdx);
}

function isPtfCondition(cond) {
  const section  = cond.section  || '';
  const category = cond.category || '';
  const text     = cond.text     || '';
  const code     = cond.code ? String(cond.code) : '';

  if (code && AMWEST_PTF_CODES.has(code)) return true;
  if (isPtfSection(section)) return true;
  if (/\b(ptf|prior to funding)\b/i.test(category)) return true;
  if (/\b(ptf|prior to funding)\b/i.test(text)) return true;

  const PTF_TEXT_PATTERNS = [
    /^final urla\b/i,
    /^final cd\b/i,
    /^send original note/i,
    /\bcpl and wire instructions\b/i,
    /settlement agent to provide fee sheet/i,
    /^borrowers own funds/i,
    /\*{2,}\s*fyi\s*\*{2,}/i,
    /^fyi\s*[-–]/i,
    /lock exp.*rescission exp/i
  ];
  return PTF_TEXT_PATTERNS.some(re => re.test(text));
}

function excludePtfConditions(conditions) {
  const kept = conditions.filter(c => !isPtfCondition(c));
  const excluded = conditions.length - kept.length;
  if (excluded > 0) log('ptf-excluded', { count: excluded });
  return kept;
}

const CONDITION_CATEGORIES = [
  'Property (FL)', 'Property', 'Closing Disclosure', 'Appraisal',
  'Income', 'Invoice', 'CREDIT', 'Credit', 'Title', 'TC'
];

function normalizePdfText(text) {
  return text.replace(/\u00ad/g, '').replace(/­/g, '').replace(/\u00a0/g, ' ');
}

function findConditionsSection(text) {
  const normalized = normalizePdfText(text);
  const match = normalized.match(/(?:locked\.\s*|Note rate is subject[^\n]*\n)\s*CONDITIONS\s*\n/i);
  if (match) {
    const idx = normalized.indexOf(match[0]);
    return normalized.slice(idx + match[0].length);
  }
  const needle = '\nCONDITIONS\n';
  const idx = normalized.lastIndexOf(needle);
  if (idx !== -1) return normalized.slice(idx + needle.length);
  return null;
}

const UWM_CATEGORIES = [
  'Closing Disclosure', 'HOMEOWNERS INSURANCE', 'Flood Insurance',
  'Purchase Agreement', 'Appraisal (Conv)', 'Appraisal',
  'Closing', 'Income', 'Purchase', 'Insurance', 'Invoice', 'Credit', 'Title', 'HOI', 'REO', 'TC'
].sort((a, b) => b.length - a.length);

function parseUwmConditionLine(line) {
  const clean = line.replace(/\u00a0/g, ' ').trim();
  const m = clean.match(/^(\d{4})(.+)$/);
  if (!m) return null;

  const spaced = clean.match(/^(\d{4})\s+(\S+)\s+(.+)$/);
  if (spaced) {
    return { code: spaced[1], category: spaced[2], text: spaced[3].trim() };
  }

  const rest = m[2];
  for (const cat of UWM_CATEGORIES) {
    if (rest.startsWith(cat)) {
      return { code: m[1], category: cat, text: rest.slice(cat.length).trim() };
    }
  }

  return null;
}

function parseConditionLine(line) {
  const uwm = parseUwmConditionLine(line);
  if (uwm) return uwm;

  const clean = line.replace(/\u00a0/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
  const spaced = clean.match(/^(\d{4})\s+(\S+)\s+(.+)$/);
  if (spaced) {
    return { code: spaced[1], category: spaced[2], text: spaced[3].trim() };
  }
  const jammed = clean.match(/^(\d{4})(.+)$/);
  if (!jammed) return null;
  const rest = jammed[2];
  for (const cat of CONDITION_CATEGORIES) {
    if (rest.startsWith(cat)) {
      return { code: jammed[1], category: cat, text: rest.slice(cat.length).trim() };
    }
  }
  return null;
}

function isUwmSectionHeader(line) {
  const t = line.trim();
  if (/^master$/i.test(t)) return true;
  if (/^uw\s*prior/i.test(t)) return true;
  if (/underwriter to obtain and clear/i.test(t)) return true;
  if (/^prior to funding/i.test(t)) return true;
  if (/^prior to documentation/i.test(t)) return true;
  if (/^prior to cd/i.test(t)) return true;
  if (/compliance/i.test(t) && /prior to closing/i.test(t)) return true;
  if (/^closing\s*\(/i.test(t) && /ptf/i.test(t)) return true;
  if (/^broker\/lo/i.test(t)) return true;
  if (/^closing agent/i.test(t)) return true;
  if (/^note to all/i.test(t)) return true;
  return false;
}

function isExcludedUwmBorrowerCondition(cond) {
  if (isPtfCondition(cond)) return true;
  const section = (cond.section ?? '').trim();
  if (/^master$/i.test(section)) return true;
  if (/underwriter to obtain and clear/i.test(section)) return true;
  return false;
}

function isSectionHeader(line) {
  if (/^\d{4}/.test(line)) return false;
  if (line.length > 100) return false;
  if (/^(provide|if |upon|are |the |and |to |for |negligent)/i.test(line)) return false;
  return /^(master|uw[\s\-]*prior|underwriter|closing\b|prior\s+to\s+funding|broker\/lo|closing agent|note to all)/i.test(line)
    || (line.length < 70 && /^[A-Z]/.test(line) && !/Provide|TC:/.test(line));
}

// Structured parser for UWM conditional approval PDFs
function parseUwmApprovalLetter(text) {
  const normalized = normalizePdfText(text);
  if (!/LOAN APPROVAL CONDITIONS/i.test(normalized)) return null;

  const borrowerMatch = normalized.match(/Borrower\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
  const headerMatch   = normalized.match(/LOAN APPROVAL CONDITIONS\s*-\s*\S+\s*-\s*(\d+)/i);

  const sectionBody = findConditionsSection(normalized);
  if (!sectionBody) return null;

  let section = sectionBody;
  for (const marker of ['EXPIRATION DATES', 'Mortgagee Clause']) {
    const idx = section.indexOf(marker);
    if (idx !== -1) section = section.slice(0, idx);
  }

  const lines = section.split('\n').map(l => l.trim()).filter(Boolean);
  const conditions = [];
  let currentSection = '';
  let current = null;

  for (const line of lines) {
    if (isUwmSectionHeader(line)) {
      if (current) { conditions.push(current); current = null; }
      currentSection = line;
      if (isPtfSection(line)) break;
      continue;
    }

    const parsed = parseUwmConditionLine(line);
    if (parsed) {
      if (current) conditions.push(current);
      current = { ...parsed, section: currentSection };
      continue;
    }

    if (current) current.text += ' ' + line;
  }
  if (current) conditions.push(current);

  const ptd = conditions.filter(c => !isExcludedUwmBorrowerCondition({
    section: c.section, category: c.category, text: c.text
  }));
  if (!ptd.length) return null;

  return {
    borrower_name: borrowerMatch?.[1]?.trim() ?? null,
    loan_number:   headerMatch?.[1] ?? null,
    conditions: ptd.map(c => ({
      code:         c.code,
      category:     c.category,
      section:      c.section,
      text:         formatConditionTitle({ code: c.code, category: c.category, text: c.text }),
      needs_review: false
    }))
  };
}

function buildPrompt(text) {
  return `You are a mortgage processor assistant. Extract loan conditions from the text below.

Rules:
- Return ONLY a valid JSON object, no markdown, no explanation
- Each condition must be a clear, actionable item
- Include condition code if present (e.g. UWM codes like 3308, 1085)
- Include section name when visible (e.g. "UW Prior To Final Approval (PTD)", "Closing (PTF)")
- NEVER include Prior to Funding (PTF) or Closing (PTF) conditions — skip that entire section
- Only include Prior to Docs/Documentation (PTD) and underwriting conditions, not funding/closing table items
- Ignore boilerplate: headers, footers, greetings, legal disclaimers, contact info
- If an item is ambiguous or unclear, include it with needs_review: true
- Try to identify the borrower name and loan number from context

Text to parse:
${text.slice(0, 12000)}

Return this exact JSON shape:
{
  "borrower_name": "string or null",
  "loan_number": "string or null",
  "conditions": [
    { "code": "string or null", "category": "string or null", "section": "string or null", "text": "condition text", "needs_review": false }
  ]
}`;
}

async function extractWithClaude(text) {
  const message = await anthropic.messages.create({
    model:      'claude-sonnet-4-5',
    max_tokens: 2048,
    messages:   [{ role: 'user', content: buildPrompt(text) }]
  });
  const raw = message.content[0].text.trim();
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Claude returned non-JSON: ' + raw.slice(0, 200));
  }
}

function normalizeText(text) {
  return text.toLowerCase().replace(/\s+/g, ' ').replace(/[^\w\s]/g, '').trim();
}

const SECTION_LABEL_CODES = new Set(['PTA', 'PTCD', 'PTD', 'PTF', 'PTE']);

function extractCode(title) {
  const sectionLabel = title.match(/^(PTA|PTCD|PTD|PTF|PTE)\s*\|/);
  if (sectionLabel) return sectionLabel[1];

  const sectionCode = title.match(/^((?:PTA|PTCD|PTD|PTF|PTE)-\d{2,3})\s*\|/);
  if (sectionCode) return sectionCode[1];

  const alphaNum = title.match(/^([A-Z]{2,4}\d+(?:\.\d+)?)\s*\|/);
  if (alphaNum) return alphaNum[1];

  const m = title.match(/^(\d{4})\b|\[(\d{4})\]|^(\d{4})\s*\|/);
  return m ? (m[1] || m[2] || m[3]) : null;
}

function conditionsMatch(pdfCond, notionTitle) {
  const notionCode = extractCode(notionTitle);
  if (
    pdfCond.code && notionCode &&
    pdfCond.code === notionCode &&
    !SECTION_LABEL_CODES.has(pdfCond.code)
  ) {
    return true;
  }

  const normPdf    = normalizeText(pdfCond.text);
  const normNotion = normalizeText(notionTitle);
  if (!normPdf || !normNotion) return false;

  const snippet = normPdf.slice(0, 50);
  if (snippet.length >= 20 && (normNotion.includes(snippet) || normPdf.includes(normNotion.slice(0, 50)))) {
    return true;
  }

  // Match informal titles like "ACE PDR" against PDF text or category labels
  if (normNotion.length <= 30 && normPdf.includes(normNotion)) return true;

  return false;
}

async function getOpenConditionsForLoan(loanPageId) {
  const r = await queryDatabase(CONDITIONS_DB, {
    and: [
      { property: 'Loan', relation: { contains: loanPageId } },
      { or: [
        { property: 'Status', select: { equals: 'Open' } },
        { property: 'Status', select: { equals: 'In Progress' } }
      ]}
    ]
  });
  return r.results;
}

async function conditionExists(loanPageId, conditionText) {
  const r = await queryDatabase(CONDITIONS_DB, {
    and: [
      { property: 'Loan',      relation: { contains: loanPageId } },
      { property: 'Condition', title:    { equals: conditionText } }
    ]
  });
  return r.results.length > 0;
}

async function addConditionToNotion(loanPageId, conditionText, needsReview, meta = {}, { skipDuplicateCheck = false } = {}) {
  if (!skipDuplicateCheck && await conditionExists(loanPageId, conditionText)) {
    log('skipped-duplicate', { conditionText: conditionText.slice(0, 60) });
    return false;
  }
  await createPage(CONDITIONS_DB, buildConditionProperties({
    conditionText,
    loanPageId,
    needsReview,
    borrowerLastName: meta.borrowerLastName,
    lenderName: meta.lenderName,
    source: 'Underwriter'
  }));
  return true;
}

async function clearCondition(pageId, title) {
  await updatePage(pageId, { 'Status': { select: { name: 'Cleared' } } });
  log('cleared', { condition: title.slice(0, 80) });
}

async function clearMatchedConditions(loanPageId, pdfConditions) {
  if (!pdfConditions.length) return [];

  const existing = await getOpenConditionsForLoan(loanPageId);
  const clearedList = [];

  for (const pdfCond of pdfConditions) {
    const match = existing.find(n => {
      const title = n.properties?.['Condition']?.title?.[0]?.plain_text ?? '';
      return conditionsMatch(pdfCond, title);
    });
    if (!match) continue;
    const title = match.properties?.['Condition']?.title?.[0]?.plain_text ?? pdfCond.text;
    await clearCondition(match.id, title);
    clearedList.push(title);
  }

  return clearedList;
}

async function syncConditionsToNotion(loanPageId, pdfConditions, meta = {}, { mirror = false } = {}) {
  const existing = await getOpenConditionsForLoan(loanPageId);
  const matchedNotionIds = new Set();
  const openCodes = new Set(
    existing
      .map(n => extractCode(n.properties?.['Condition']?.title?.[0]?.plain_text ?? ''))
      .filter(code => code && !SECTION_LABEL_CODES.has(code))
  );

  let added = 0;
  let unchanged = 0;
  const addedList = [];

  function findUnmatchedExisting(pdfCond) {
    return existing.find(n => {
      if (matchedNotionIds.has(n.id)) return false;
      const title = n.properties?.['Condition']?.title?.[0]?.plain_text ?? '';
      if (conditionsMatch(pdfCond, title)) return true;
      if (pdfCond.code && extractCode(title) === pdfCond.code) return true;
      return false;
    });
  }

  for (const pdfCond of pdfConditions) {
    const match = findUnmatchedExisting(pdfCond);

    if (match) {
      matchedNotionIds.add(match.id);
      unchanged++;
      continue;
    }

    if (pdfCond.code && openCodes.has(pdfCond.code)) {
      log('skipped-duplicate-code', { code: pdfCond.code });
      unchanged++;
      continue;
    }

    const wasAdded = await addConditionToNotion(
      loanPageId, pdfCond.text, pdfCond.needs_review ?? false, meta
    );
    if (wasAdded) {
      added++;
      addedList.push(pdfCond.text);
      if (pdfCond.code) openCodes.add(pdfCond.code);
    }
  }

  const clearedList = [];
  if (mirror) {
    for (const n of existing) {
      if (matchedNotionIds.has(n.id)) continue;
      const title = n.properties?.['Condition']?.title?.[0]?.plain_text ?? '';
      if (!title) continue;
      await clearCondition(n.id, title);
      clearedList.push(title);
    }
    if (clearedList.length) {
      log('mirror-cleared', { count: clearedList.length });
    }
  }

  return {
    added,
    cleared: clearedList.length,
    unchanged,
    total: pdfConditions.length,
    addedList,
    clearedList
  };
}

async function handle({ subject, from, body, pdfBuffer, msgId, gmail, threadId, inboxLabel, attachmentFilename = '' }) {
  log('start', { subject, msgId, hasPdf: !!pdfBuffer, attachmentFilename: attachmentFilename || undefined });

  if (!pdfBuffer) {
    log('skip', { reason: 'approval pdf required' });
    return;
  }

  let text = body;
  try {
    text = await extractPdfText(pdfBuffer);
    log('pdf-extracted', { chars: text.length });
  } catch (err) {
    log('pdf-error', { error: err.message });
    return;
  }

  if (!text || text.trim().length < 20) {
    log('skip', { reason: 'insufficient text' });
    return;
  }

  const subjectHints = extractFromSubject(subject);
  const filenameHints = extractFromFilename(attachmentFilename);
  let parserLender = null;
  let isCtcCase = false;
  let parsed = parseUwmApprovalLetter(text);

  if (parsed) {
    parserLender = 'UWM';
    log('uwm-parsed', { borrower: parsed.borrower_name, loan: parsed.loan_number, count: parsed.conditions.length });
  } else {
    const { parseNewrezApprovalLetter } = require('./newrez-parser');
    parsed = parseNewrezApprovalLetter(text);
    if (parsed) {
      parserLender = 'Newrez';
      log('newrez-parsed', { borrower: parsed.borrower_name, loan: parsed.loan_number, count: parsed.conditions.length });
    }
  }

  if (!parsed) {
    const { parseAcraApprovalLetter } = require('./acra-parser');
    parsed = parseAcraApprovalLetter(text);
    if (parsed) {
      parserLender = 'Acra';
      log('acra-parsed', { borrower: parsed.borrower_name, loan: parsed.loan_number, count: parsed.conditions.length });
    }
  }

  if (!parsed) {
    const { parseNationsDirectApproval } = require('./nations-direct-parser');
    parsed = parseNationsDirectApproval(text);
    if (parsed) {
      parserLender = 'Nations Direct';
      log('nations-direct-parsed', { borrower: parsed.borrower_name, loan: parsed.loan_number, count: parsed.conditions.length });
    }
  }

  if (!parsed) {
    const { parseArcApprovalLetter } = require('./arc-parser');
    parsed = parseArcApprovalLetter(text);
    if (parsed) {
      parserLender = 'ARC';
      log('arc-parsed', { borrower: parsed.borrower_name, loan: parsed.loan_number, count: parsed.conditions.length });
    }
  }

  if (!parsed) {
    const { parseOpenConditionsApproval } = require('./open-conditions-parser');
    parsed = parseOpenConditionsApproval(text);
    if (parsed) {
      parserLender = 'Open Mortgage';
      log('open-conditions-parsed', { borrower: parsed.borrower_name, loan: parsed.loan_number, count: parsed.conditions.length });
    }
  }

  if (!parsed) {
    const { parseCakeApprovalLetter } = require('./cake-parser');
    parsed = parseCakeApprovalLetter(text);
    if (parsed) {
      parserLender = 'Cake';
      log('cake-parsed', { borrower: parsed.borrower_name, loan: parsed.loan_number, count: parsed.conditions.length });
    }
  }

  if (!parsed) {
    const { parseAmwestApprovalLetter } = require('./amwest-parser');
    parsed = parseAmwestApprovalLetter(text);
    if (parsed) {
      parserLender = 'AmWest';
      log('amwest-parsed', { borrower: parsed.borrower_name, loan: parsed.loan_number, count: parsed.conditions.length });
    }
  }

  if (!parsed) {
    const { parseTheloanstoreApprovalLetter } = require('./theloanstore-parser');
    parsed = parseTheloanstoreApprovalLetter(text);
    if (parsed) {
      parserLender = 'The Loan Store';
      log('theloanstore-parsed', { borrower: parsed.borrower_name, loan: parsed.loan_number, count: parsed.conditions.length });
    }
  }

  if (!parsed) {
    const { parseThelenderApprovalLetter } = require('./thelender-parser');
    parsed = parseThelenderApprovalLetter(text);
    if (parsed) {
      parserLender = 'The Lender';
      log('thelender-parsed', { borrower: parsed.borrower_name, loan: parsed.loan_number, count: parsed.conditions.length });
    }
  }

  if (!parsed) {
    const { parseBluepointApprovalLetter } = require('./bluepoint-parser');
    parsed = parseBluepointApprovalLetter(text);
    if (parsed) {
      parserLender = 'BluePoint';
      log('bluepoint-parsed', { borrower: parsed.borrower_name, loan: parsed.loan_number, count: parsed.conditions.length });
    }
  }

  if (!parsed) {
    const { parseFundloansApprovalLetter } = require('./fundloans-parser');
    parsed = parseFundloansApprovalLetter(text);
    if (parsed) {
      parserLender = 'FundLoans';
      log('fundloans-parsed', { borrower: parsed.borrower_name, loan: parsed.loan_number, count: parsed.conditions.length });
    }
  }

  if (!parsed) {
    const { parseOrionApprovalLetter } = require('./orion-parser');
    parsed = parseOrionApprovalLetter(text);
    if (parsed) {
      parserLender = 'Orion';
      log('orion-parsed', { borrower: parsed.borrower_name, loan: parsed.loan_number, count: parsed.conditions.length });
    }
  }

  if (!parsed) {
    const subjectHintsEarly = extractFromSubject(subject);
    const isCtc = /clear to close|\bctc\b/i.test(subject ?? '') ||
      /clear to close|cleared to close/i.test(text.slice(0, 3000));
    const uwmLoan = subjectHintsEarly.loan_number;

    if (isCtc && uwmLoan) {
      const borrower = (subjectHintsEarly.borrower_name ?? '')
        .replace(/\s+is\s+clear to close$/i, '')
        .trim() || null;
      parsed = {
        borrower_name: borrower,
        loan_number:   uwmLoan,
        conditions:    [],
        cleared_conditions: []
      };
      parserLender = 'UWM';
      isCtcCase = true;
      log('uwm-ctc-detected', { borrower: parsed.borrower_name, loan: parsed.loan_number });
    }
  }

  if (!parsed) {
    if (process.env.ALLOW_CLAUDE_PDF_PARSE === 'true' && looksLikeApprovalLetter(text)) {
      try {
        const stripped = stripPtfBlockFromText(text);
        parsed = await extractWithClaude(stripped);
        log('claude-parsed', { borrower: parsed.borrower_name, loan: parsed.loan_number, count: parsed.conditions?.length });
      } catch (err) {
        log('claude-error', { error: err.message });
        return;
      }
    } else {
      log('skip', { reason: 'no structured parser matched approval pdf' });
      return;
    }
  }

  const borrowerName = parsed.borrower_name ?? subjectHints.borrower_name ?? filenameHints.borrower_name;
  const loanNumber   = parsed.loan_number   ?? subjectHints.loan_number   ?? filenameHints.loan_number;
  let clearedFromPdf = (parsed.cleared_conditions ?? []).map(c => ({
    code:         c.code ?? null,
    category:     c.category ?? null,
    section:      c.section ?? null,
    text:         c.text,
    needs_review: c.needs_review ?? false
  }));
  let conditions   = excludePtfConditions((parsed.conditions ?? []).map(c => ({
    code:         c.code ?? null,
    category:     c.category ?? null,
    section:      c.section ?? null,
    text:         c.text,
    needs_review: c.needs_review ?? false
  })));

  if (!conditions.length && !clearedFromPdf.length) {
    if (!pdfBuffer) {
      log('skip', { reason: 'no conditions found' });
      return;
    }
    log('mirror-empty-pdf', { reason: 'approval pdf has no open conditions — will clear Notion' });
  }

  const lenderName = detectLenderName({ from, subject, pdfText: text, parserLender });
  const borrowerLastName = extractBorrowerLastName(borrowerName);
  const conditionMeta = { borrowerLastName, lenderName };

  const { loan, created } = await findOrCreateLoanFromApproval({ borrowerName, loanNumber, lenderName });

  if (!loan) {
    log('loan-not-found', { borrower: borrowerName, loan: loanNumber, from, subject, reason: 'missing borrower and loan number' });
    return;
  }

  if (created) {
    log('loan-created-from-approval', { borrower: borrowerName, loan: loanNumber, notionPageId: loan.id });
  }

  const loanName = loan.properties?.['Borrower Name']?.title?.[0]?.plain_text ?? borrowerName;
  if (!conditionMeta.lenderName) {
    conditionMeta.lenderName = loan.properties?.Lender?.rich_text?.[0]?.plain_text ?? null;
  }

  if (isCtcCase && loanNumber) {
    const notionLoanNum = getLoanNumberFromPage(loan);
    if (loanNumbersMatch(loanNumber, notionLoanNum)) {
      const archived = await finalizeClearToCloseLoan(loan);
      log('ctc-finalized', {
        loan: loanName,
        emailLoan: loanNumber,
        notionLoan: notionLoanNum,
        conditionsArchived: archived.conditionsArchived
      });
      await sendSyncNotification({
        gmail, msgId, threadId, inboxLabel,
        origSubject: subject,
        loanName,
        result: {
          added: 0,
          cleared: archived.conditionsArchived,
          addedList: [],
          clearedList: [`Clear to Close — archived loan and ${archived.conditionsArchived} condition(s)`]
        }
      });
      return;
    }
    log('ctc-loan-number-mismatch', { emailLoan: loanNumber, notionLoan: notionLoanNum, borrower: borrowerName });
  }

  if (pdfBuffer) {
    let syncConditions = conditions;
    let syncClears = clearedFromPdf;
    let validatorOutcome;

    if (process.env.VALIDATOR_ENABLED === 'true') {
      const {
        validateConditions,
        sendValidatorHoldNotification,
        sendValidatorDissentNotification
      } = require('./condition-validator');
      const existing = await getOpenConditionsForLoan(loan.id);
      const existingTitles = existing
        .map(n => n.properties?.['Condition']?.title?.[0]?.plain_text ?? '')
        .filter(Boolean);

      const validation = await validateConditions({
        rawPdfText: text,
        conditionsToAdd: syncConditions,
        conditionsToClear: syncClears,
        existingNotionConditions: existingTitles,
        borrowerName,
        loanNumber,
        subject
      });

      log('validator-result', {
        loan: loanName,
        proceed: validation.proceed,
        votes: validation.votes,
        confidence: validation.confidence,
        outcome: validation.outcome,
        addApproved: validation.validatedAdd.length,
        clearApproved: validation.validatedClear.length,
        ignored: validation.ignored.length
      });

      if (!validation.proceed) {
        await sendValidatorHoldNotification({
          origSubject: subject,
          loanName,
          borrowerName,
          loanNumber,
          validation
        });
        return;
      }

      syncConditions = validation.validatedAdd;
      syncClears = validation.validatedClear;
      validatorOutcome = validation;
    }

    const result = await syncConditionsToNotion(loan.id, syncConditions, conditionMeta, { mirror: true });

    if (syncClears.length) {
      const pdfCleared = await clearMatchedConditions(loan.id, syncClears);
      result.cleared += pdfCleared.length;
      result.clearedList = [...result.clearedList, ...pdfCleared];
      log('pdf-cleared', { count: pdfCleared.length });
    }

    log('sync-done', { loan: loanName, ...result });

    if (validatorOutcome?.outcome === 'approved_with_dissent') {
      const { sendValidatorDissentNotification } = require('./condition-validator');
      await sendValidatorDissentNotification({
        origSubject: subject,
        loanName,
        borrowerName,
        loanNumber,
        validation: validatorOutcome
      });
    }

    await sendSyncNotification({
      gmail, msgId, threadId, inboxLabel,
      origSubject: subject,
      loanName,
      result
    });
    return;
  }

  // Email body only — add new conditions without clearing existing ones
  let added = 0;
  const addedList = [];
  for (const cond of conditions) {
    const wasAdded = await addConditionToNotion(loan.id, cond.text, cond.needs_review, conditionMeta);
    if (wasAdded) {
      added++;
      addedList.push(cond.text);
    }
  }

  log('done', { loan: loanName, added, total: conditions.length });

  await sendSyncNotification({
    gmail, msgId, threadId, inboxLabel,
    origSubject: subject,
    loanName,
    result: { added, cleared: 0, addedList, clearedList: [] }
  });
}

async function clearPtfConditionsForLoan(borrowerRef, loanNumber) {
  const loan = await findLoanByNumberOrBorrower(loanNumber ?? null, borrowerRef);
  if (!loan) throw new Error(`Loan not found for: ${borrowerRef}${loanNumber ? ` / ${loanNumber}` : ''}`);

  const existing = await getOpenConditionsForLoan(loan.id);
  const clearedList = [];

  for (const notionCond of existing) {
    const title = notionCond.properties?.['Condition']?.title?.[0]?.plain_text ?? '';
    if (!isPtfCondition({ text: title })) continue;
    await updatePage(notionCond.id, { 'Status': { select: { name: 'Cleared' } } });
    clearedList.push(title);
    log('ptf-cleared', { title: title.slice(0, 80) });
  }

  const loanName = loan.properties?.['Borrower Name']?.title?.[0]?.plain_text ?? borrowerRef;
  return { loan: loanName, cleared: clearedList.length, clearedList, remaining: existing.length - clearedList.length };
}

module.exports = {
  process: handle,
  parseUwmApprovalLetter,
  isPtfCondition,
  isExcludedUwmBorrowerCondition,
  excludePtfConditions,
  clearPtfConditionsForLoan,
  conditionsMatch,
  extractCode
};
