require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { sendToBothInboxes } = require('./send-email');

// Local dev: borrow Anthropic key from notionagent if not in this project's .env
if (!process.env.ANTHROPIC_API_KEY) {
  for (const rel of ['notionagent', 'Emailmonitoragent']) {
    const envPath = path.join(__dirname, '..', '..', rel, '.env');
    if (fs.existsSync(envPath)) {
      require('dotenv').config({ path: envPath, override: false });
      if (process.env.ANTHROPIC_API_KEY) break;
    }
  }
}

let _anthropic;
function getClient() {
  if (!_anthropic) {
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _anthropic;
}
const VALIDATOR_MODEL = process.env.VALIDATOR_MODEL || 'claude-haiku-4-5-20251001';
const VALIDATOR_CHUNK_SIZE = parseInt(process.env.VALIDATOR_CHUNK_SIZE || '10', 10);
const CHECKER_A_THRESHOLD = parseFloat(process.env.CHECKER_A_THRESHOLD || '0.85');
const CHECKER_B_THRESHOLD = parseFloat(process.env.CHECKER_B_THRESHOLD || '0.65');

const BOILERPLATE_PATTERNS = [
  /equal housing/i,
  /\bnmls\b/i,
  /intended only for/i,
  /^fyi\s[-–]/i,
  /mimecast/i,
  /automatically archived/i,
  /unauthorized use/i,
  /^thank you for choosing/i,
  /^please contact your/i
];

function log(action, detail) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), handler: 'condition-validator', action, ...detail }));
}

function normalizeText(text) {
  return (text || '').toLowerCase().replace(/\s+/g, ' ').replace(/[^\w\s]/g, '').trim();
}

function rulesRejectReason(text, existingNorm) {
  const trimmed = (text || '').trim();
  if (!trimmed) return 'empty text';
  if (trimmed.length < 12 && !/^\d{3,4}\s*\|/.test(trimmed)) return 'too short';
  if (BOILERPLATE_PATTERNS.some(re => re.test(trimmed))) return 'boilerplate';
  const norm = normalizeText(trimmed);
  if (norm && existingNorm.has(norm)) return 'already in Notion';
  return null;
}

function applyRulesFilter(conditionsToAdd, existingNotionConditions) {
  const existingNorm = new Set(existingNotionConditions.map(normalizeText).filter(Boolean));
  const validatedAdd = [];
  const ignored = [];

  for (const cond of conditionsToAdd) {
    const reason = rulesRejectReason(cond.text, existingNorm);
    if (reason) {
      ignored.push({ text: cond.text, action: 'ignore', reason, stage: 'rules' });
    } else {
      validatedAdd.push(cond);
    }
  }

  return { validatedAdd, ignored };
}

function buildCheckerPrompt(mode, { rawPdfText, addTexts, clearTexts, existingNotionConditions, borrowerName, loanNumber }) {
  const threshold = mode === 'strict' ? CHECKER_A_THRESHOLD : CHECKER_B_THRESHOLD;
  const persona = mode === 'strict'
    ? `You are Checker A — a STRICT mortgage condition validator.
Verify every extracted condition appears in or is clearly supported by the PDF text.
Reject paraphrases that change meaning, missing source support, PTF/closing items, and boilerplate.
Set approved true only if confidence >= ${threshold}.`
    : `You are Checker B — a LENIENT mortgage condition validator.
Focus on whether each item is a real, actionable underwriting/doc condition.
Allow formatting differences, minor wording changes, and standard condition phrasing.
Set approved true only if confidence >= ${threshold}.`;

  return `${persona}

Loan: ${borrowerName || 'unknown'} / ${loanNumber || 'unknown'}

For each ADD item: action "add" or "ignore".
For each CLEAR item: action "clear" or "ignore" (only if PDF shows it cleared).

Raw PDF text:
${rawPdfText}

Conditions proposed for ADD:
${JSON.stringify(addTexts, null, 2)}

Conditions proposed for CLEAR:
${JSON.stringify(clearTexts, null, 2)}

Existing open Notion conditions (context only):
${JSON.stringify(existingNotionConditions, null, 2)}

Return ONLY valid JSON:
{
  "approved": true,
  "confidence": 0.0,
  "issues": [],
  "add_decisions": [{ "text": "exact text", "action": "add" | "ignore", "reason": "brief" }],
  "clear_decisions": [{ "text": "exact text", "action": "clear" | "ignore", "reason": "brief" }]
}

Every ADD and CLEAR item must appear in the matching decisions array.`;
}

function parseAiJson(raw) {
  let trimmed = raw.trim();
  if (trimmed.startsWith('```')) {
    trimmed = trimmed.replace(/^```(?:json)?\n?/, '').replace(/\n```$/, '');
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Validator returned non-JSON: ' + trimmed.slice(0, 200));
  }
}

async function runAiChecker(name, mode, payload) {
  const threshold = mode === 'strict' ? CHECKER_A_THRESHOLD : CHECKER_B_THRESHOLD;
  const message = await getClient().messages.create({
    model: VALIDATOR_MODEL,
    max_tokens: 4096,
    messages: [{ role: 'user', content: buildCheckerPrompt(mode, payload) }]
  });
  const result = parseAiJson(message.content[0].text);
  const confidence = typeof result.confidence === 'number' ? result.confidence : 0;
  result.checker = name;
  result.approved = result.approved === true && confidence >= threshold;
  return result;
}

function chunkList(list, size) {
  if (!list.length) return [];
  const chunks = [];
  for (let i = 0; i < list.length; i += size) {
    chunks.push(list.slice(i, i + size));
  }
  return chunks;
}

function mergeChunkCheckerResults(name, mode, chunks) {
  const threshold = mode === 'strict' ? CHECKER_A_THRESHOLD : CHECKER_B_THRESHOLD;
  if (!chunks.length) {
    return {
      checker: name,
      approved: false,
      confidence: 0,
      issues: ['no validator chunks ran'],
      add_decisions: [],
      clear_decisions: []
    };
  }

  const confidence = chunks.reduce((s, c) => s + (c.confidence || 0), 0) / chunks.length;
  const allChunksApproved = chunks.every(c => c.approved === true);

  return {
    checker: name,
    approved: allChunksApproved && confidence >= threshold,
    confidence,
    issues: chunks.flatMap(c => c.issues || []),
    add_decisions: chunks.flatMap(c => c.add_decisions || []),
    clear_decisions: chunks.flatMap(c => c.clear_decisions || [])
  };
}

async function runAiCheckerChunked(name, mode, payload) {
  const { addTexts, clearTexts, ...rest } = payload;
  const addChunks = chunkList(addTexts, VALIDATOR_CHUNK_SIZE);
  const clearChunks = chunkList(clearTexts, VALIDATOR_CHUNK_SIZE);
  const batchCount = Math.max(addChunks.length, clearChunks.length, 1);

  if (addTexts.length <= VALIDATOR_CHUNK_SIZE && clearTexts.length <= VALIDATOR_CHUNK_SIZE) {
    return runAiChecker(name, mode, payload);
  }

  log('chunked-validation', {
    checker: name,
    addItems: addTexts.length,
    clearItems: clearTexts.length,
    batches: batchCount
  });

  const chunkResults = [];
  for (let i = 0; i < batchCount; i++) {
    const batchAdd = addChunks[i] || [];
    const batchClear = clearChunks[i] || [];
    if (!batchAdd.length && !batchClear.length) continue;
    chunkResults.push(await runAiChecker(name, mode, {
      ...rest,
      addTexts: batchAdd,
      clearTexts: batchClear
    }));
  }

  return mergeChunkCheckerResults(name, mode, chunkResults);
}

function buildRulesChecker(rulesAdd, rulesIgnored, clearTexts) {
  const hasWork = rulesAdd.length > 0 || clearTexts.length > 0;
  const addDecisions = [
    ...rulesAdd.map(c => ({ text: c.text, action: 'add', reason: 'passed rules filter' })),
    ...rulesIgnored.map(c => ({ text: c.text, action: 'ignore', reason: c.reason }))
  ];
  const clearDecisions = clearTexts.map(text => ({
    text,
    action: 'clear',
    reason: 'passed rules filter'
  }));

  return {
    checker: 'Checker C (rules)',
    approved: hasWork || rulesIgnored.length > 0,
    confidence: 1,
    issues: hasWork ? [] : ['no conditions remain after rules filter'],
    add_decisions: addDecisions,
    clear_decisions: clearDecisions
  };
}

function decisionMap(decisions) {
  const map = new Map();
  for (const d of decisions || []) {
    if (d.text) map.set(normalizeText(d.text), d);
  }
  return map;
}

function actionVotes(checkers, list, field, action) {
  const votes = new Map();
  for (const text of list) {
    const norm = normalizeText(text);
    let count = 0;
    for (const checker of checkers) {
      const decision = decisionMap(checker[`${field}_decisions`]).get(norm);
      if (decision?.action === action) count++;
    }
    votes.set(norm, count);
  }
  return votes;
}

function mergeByMajority(approvingCheckers, rulesAdd, conditionsToClear, minVotes) {
  const addTexts = rulesAdd.map(c => c.text);
  const clearTexts = conditionsToClear.map(c => c.text);
  const addVotes = actionVotes(approvingCheckers, addTexts, 'add', 'add');
  const clearVoteMap = actionVotes(approvingCheckers, clearTexts, 'clear', 'clear');

  const validatedAdd = rulesAdd.filter(c => (addVotes.get(normalizeText(c.text)) || 0) >= minVotes);
  const validatedClear = conditionsToClear.filter(c => (clearVoteMap.get(normalizeText(c.text)) || 0) >= minVotes);

  const addIgnored = rulesAdd
    .filter(c => (addVotes.get(normalizeText(c.text)) || 0) < minVotes)
    .map(c => ({ text: c.text, action: 'ignore', reason: 'did not reach checker majority', stage: 'ensemble' }));

  const clearIgnored = conditionsToClear
    .filter(c => (clearVoteMap.get(normalizeText(c.text)) || 0) < minVotes)
    .map(c => ({ text: c.text, action: 'ignore', reason: 'did not reach checker majority', stage: 'ensemble' }));

  return { validatedAdd, validatedClear, ignored: [...addIgnored, ...clearIgnored] };
}

function avgConfidence(checkers) {
  const vals = checkers.map(c => c.confidence).filter(n => typeof n === 'number');
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
}

async function validateConditions({
  rawPdfText,
  conditionsToAdd,
  conditionsToClear,
  existingNotionConditions,
  borrowerName,
  loanNumber,
  subject
}) {
  const { validatedAdd: rulesAdd, ignored: rulesIgnored } = applyRulesFilter(
    conditionsToAdd,
    existingNotionConditions
  );

  const addTexts = rulesAdd.map(c => c.text);
  const clearTexts = conditionsToClear.map(c => c.text);
  const payload = {
    rawPdfText: rawPdfText.slice(0, 12000),
    addTexts,
    clearTexts,
    existingNotionConditions,
    borrowerName,
    loanNumber
  };

  const checkerC = buildRulesChecker(rulesAdd, rulesIgnored, clearTexts);

  if (!addTexts.length && !clearTexts.length) {
    log('skip-ai', { reason: 'nothing left after rules filter', rulesIgnored: rulesIgnored.length });
    return {
      proceed: true,
      votes: 3,
      confidence: 1,
      outcome: 'auto_approved',
      validatedAdd: [],
      validatedClear: [],
      proposedAdd: [],
      proposedClear: [],
      ignored: rulesIgnored,
      issues: [],
      subject,
      checkerResults: [checkerC]
    };
  }

  let checkerA;
  let checkerB;
  try {
    [checkerA, checkerB] = await Promise.all([
      runAiCheckerChunked('Checker A (strict)', 'strict', payload),
      runAiCheckerChunked('Checker B (lenient)', 'lenient', payload)
    ]);
  } catch (err) {
    log('ai-error', { error: err.message });
    return {
      proceed: false,
      votes: 0,
      confidence: 0,
      outcome: 'held_for_review',
      validatedAdd: [],
      validatedClear: [],
      ignored: rulesIgnored,
      issues: [`Validator API error: ${err.message}`],
      subject,
      checkerResults: [checkerC]
    };
  }

  const allCheckers = [checkerA, checkerB, checkerC];
  const votes = allCheckers.filter(c => c.approved).length;
  const approvers = allCheckers.filter(c => c.approved);
  const dissenters = allCheckers.filter(c => !c.approved);

  log('ensemble-votes', {
    votes,
    a: checkerA.approved,
    b: checkerB.approved,
    c: checkerC.approved,
    aConf: checkerA.confidence,
    bConf: checkerB.confidence
  });

  let outcome;
  let proceed = false;
  let minVotes = 2;

  if (votes === 3) {
    outcome = 'auto_approved';
    proceed = true;
    minVotes = 2;
  } else if (votes === 2) {
    outcome = 'approved_with_dissent';
    proceed = true;
    minVotes = 2;
  } else {
    outcome = 'held_for_review';
    proceed = false;
  }

  const { validatedAdd, validatedClear, ignored: ensembleIgnored } = mergeByMajority(
    approvers.length ? approvers : allCheckers,
    rulesAdd,
    conditionsToClear,
    minVotes
  );

  const ignored = [...rulesIgnored, ...ensembleIgnored];
  const issues = allCheckers.flatMap(c => (c.issues || []).map(i => `[${c.checker}] ${i}`));
  const confidence = avgConfidence(allCheckers);
  const preview = mergeByMajority(allCheckers, rulesAdd, conditionsToClear, 2);

  return {
    proceed,
    votes,
    confidence,
    outcome,
    validatedAdd: proceed ? validatedAdd : [],
    validatedClear: proceed ? validatedClear : [],
    proposedAdd: preview.validatedAdd,
    proposedClear: preview.validatedClear,
    ignored,
    issues,
    subject,
    dissenters,
    checkerResults: allCheckers
  };
}

function formatCheckerSummary(checkerResults) {
  return (checkerResults || []).map(r => {
    const status = r.approved ? 'APPROVED' : 'REJECTED';
    const issues = (r.issues || []).map(i => `    • ${i}`).join('\n') || '    None';
    return `${r.checker} — ${status} (confidence ${((r.confidence || 0) * 100).toFixed(0)}%)\n  Issues:\n${issues}`;
  }).join('\n\n');
}

function formatHoldBody({ origSubject, loanName, borrowerName, loanNumber, validation }) {
  const lines = [
    'PDF condition sync was HELD — fewer than 2 of 3 checkers approved.',
    'Review the extracted conditions and update Notion manually if needed.',
    '',
    `Original email: ${origSubject || '(unknown)'}`,
    `Loan: ${loanName}`,
    `Borrower: ${borrowerName || 'unknown'}`,
    `Loan #: ${loanNumber || 'unknown'}`,
    `Votes: ${validation.votes}/3  Confidence: ${(validation.confidence * 100).toFixed(0)}%`,
    '',
    'Checker results:',
    formatCheckerSummary(validation.checkerResults),
    ''
  ];

  if (validation.issues.length) {
    lines.push('Issues:');
    validation.issues.forEach(i => lines.push(`  • ${i}`));
    lines.push('');
  }

  if (validation.proposedAdd?.length) {
    lines.push(`Proposed ADD (${validation.proposedAdd.length}):`);
    validation.proposedAdd.forEach((c, i) => lines.push(`  ${i + 1}. ${c.text}`));
    lines.push('');
  }

  if (validation.proposedClear?.length) {
    lines.push(`Proposed CLEAR (${validation.proposedClear.length}):`);
    validation.proposedClear.forEach((c, i) => lines.push(`  ${i + 1}. ${c.text}`));
    lines.push('');
  }

  if (validation.validatedAdd?.length) {
    lines.push(`Would ADD (${validation.validatedAdd.length}):`);
    validation.validatedAdd.forEach((c, i) => lines.push(`  ${i + 1}. ${c.text}`));
    lines.push('');
  }

  if (validation.validatedClear?.length) {
    lines.push(`Would CLEAR (${validation.validatedClear.length}):`);
    validation.validatedClear.forEach((c, i) => lines.push(`  ${i + 1}. ${c.text}`));
    lines.push('');
  }

  if (validation.ignored.length) {
    lines.push(`Ignored (${validation.ignored.length}):`);
    validation.ignored.forEach((c, i) => lines.push(`  ${i + 1}. ${c.text} — ${c.reason}`));
    lines.push('');
  }

  return lines.join('\n');
}

function formatDissentBody({ origSubject, loanName, borrowerName, loanNumber, validation }) {
  const lines = [
    'PDF condition sync proceeded with 2/3 checker agreement.',
    'One checker disagreed — review the dissent below.',
    '',
    `Original email: ${origSubject || '(unknown)'}`,
    `Loan: ${loanName}`,
    `Borrower: ${borrowerName || 'unknown'}`,
    `Loan #: ${loanNumber || 'unknown'}`,
    `Votes: ${validation.votes}/3`,
    '',
    'Dissenting checker(s):',
    formatCheckerSummary(validation.dissenters),
    '',
    `Added to Notion: ${validation.validatedAdd.length}`,
    `Cleared in Notion: ${validation.validatedClear.length}`,
    `Ignored: ${validation.ignored.length}`,
    ''
  ];

  if (validation.validatedAdd.length) {
    lines.push('Added:');
    validation.validatedAdd.forEach((c, i) => lines.push(`  ${i + 1}. ${c.text}`));
    lines.push('');
  }

  if (validation.validatedClear.length) {
    lines.push('Cleared:');
    validation.validatedClear.forEach((c, i) => lines.push(`  ${i + 1}. ${c.text}`));
    lines.push('');
  }

  return lines.join('\n');
}

async function sendValidatorHoldNotification({ origSubject, loanName, borrowerName, loanNumber, validation }) {
  const subject = `[Mortgage Bot] Validator hold (${validation.votes}/3) — ${loanName || borrowerName || 'unknown loan'}`;
  const body = formatHoldBody({ origSubject, loanName, borrowerName, loanNumber, validation });
  await sendToBothInboxes(subject, body);
  log('hold-email-sent', { loan: loanName, votes: validation.votes });
}

async function sendValidatorDissentNotification({ origSubject, loanName, borrowerName, loanNumber, validation }) {
  const subject = `[Mortgage Bot] Validator dissent (${validation.votes}/3) — ${loanName || borrowerName || 'unknown loan'}`;
  const body = formatDissentBody({ origSubject, loanName, borrowerName, loanNumber, validation });
  await sendToBothInboxes(subject, body);
  log('dissent-email-sent', { loan: loanName, votes: validation.votes });
}

module.exports = {
  validateConditions,
  sendValidatorHoldNotification,
  sendValidatorDissentNotification,
  applyRulesFilter,
  normalizeText
};
