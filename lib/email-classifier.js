// Classify incoming emails into categories the handlers understand

const {
  extractLoanInfo,
  hasActionableLenderRequest
} = require('./lender-request-handler');
const { isNewrezApprovalEmail } = require('./newrez-client');
const { isApprovalPdfFilename } = require('./approval-letter');
const {
  LENDER_ROLE_KEYWORDS,
  isTitleOrClosingEmail,
  isKnownLenderEmployeeEmail,
  isBrokerEmail
} = require('./email-parties');

const IGNORE_KEYWORDS = [
  'lock confirmation', 'lock update', 'lock extension', 'relock', 're-lock',
  'rate lock confirmation', 'successfully locked', 'lock expiration date',
  'change of circumstance', 'change of circumstances', 'changed circumstance',
  'changed circumstances', 'notice of change of circumstance', 'coc notice',
  'coc confirmation', 'coc submitted', 'coc received', 'change in circumstance',
  'change of circumstance has been processed', 'your change of circumstance',
  'loan change request', 'change request has been submitted', 'reason(s) for this change request',
  'missing items for loan submission', 'missing docs for submission', 'missing documentation',
  'loan submission', 'cannot proceed with the review', 'following up with the email',
  'credentials to access', 'emportal connect', 'client support', 'recall:'
];

const PRE_APPROVAL_KEYWORDS = [
  'pre-approval', 'pre approval', 'preapproval', 'prequal', 'pre-qual',
  'pre qualification', 'prequalification'
];

const TASK_KEYWORDS = [
  'action required', 'please review', 'follow up', 'follow-up',
  'reminder', 'urgent', 'time sensitive'
];

function isUwmLoanSubject(subject) {
  return /^\d{6,}\s*[-–]\s*\S+/i.test((subject ?? '').trim());
}

function isIgnorableEmail(subject, body) {
  if (/\[mortgage bot\]/i.test(subject ?? '')) return true;
  if (/^recall:/i.test((subject ?? '').trim())) return true;
  if (/missing items for loan submission/i.test(subject ?? '')) return true;
  if (/time sensitive.*missing items/i.test(subject ?? '')) return true;
  const text = `${subject} ${body}`.toLowerCase();
  if (IGNORE_KEYWORDS.some(k => text.includes(k))) return true;
  if (/lock confirmation for the/i.test(subject ?? '')) return true;
  if (/\[lock update\]/i.test(subject ?? '')) return true;
  if (/loan change request/i.test(subject ?? '')) return true;
  return false;
}

function isApprovalPdfSubject(subject) {
  return /approval\s*letter|conditional\s+approval|loan\s+approval|initial\s+loan\s+approval/i.test(subject ?? '');
}

function isBrokerApprovalBundle(subject, body, { hasPdf = false, from = '', pdfFilenames = [] } = {}) {
  if (!hasPdf || !isBrokerEmail(from)) return false;
  const subj = (subject ?? '').trim();
  const text = `${subject} ${body}`.slice(0, 500);
  if (/approval/i.test(subj) || /approval/i.test(text)) return true;
  if (pdfFilenames.some(f => isApprovalPdfFilename(f))) return true;
  return false;
}

function isLoanDecisionEmail(subject, body) {
  return /loan decision|final review|conditional approval|approved with conditions/i.test(`${subject} ${body}`.slice(0, 500));
}

function isClearToCloseSubject(subject) {
  return /clear to close|\bctc\b/i.test(subject ?? '');
}

function isApprovalPdfCandidate(subject, body, { hasPdf = false, from = '', pdfFilename = '', pdfFilenames = [] } = {}) {
  if (!hasPdf) return false;
  if (isUwmLoanSubject(subject)) return true;
  if (isClearToCloseSubject(subject)) return true;
  if (isLoanDecisionEmail(subject, body)) return true;
  if (isApprovalPdfSubject(subject)) return true;
  if (/approvalletter/i.test(`${subject} ${body}`)) return true;
  const names = pdfFilenames.length ? pdfFilenames : (pdfFilename ? [pdfFilename] : []);
  if (names.some(f => isApprovalPdfFilename(f))) return true;
  if (isBrokerApprovalBundle(subject, body, { hasPdf, from, pdfFilenames: names })) return true;
  return false;
}

function isLenderUrgentRequest(subject, body, from) {
  if (isBrokerEmail(from)) return false;
  if (isTitleOrClosingEmail(from, subject, body)) return false;
  if (!isKnownLenderEmployeeEmail(from, body)) return false;

  const { loanNumber } = extractLoanInfo(subject, body);
  if (!loanNumber) return false;

  const text = `${subject} ${body}`.toLowerCase();
  const hasRole = LENDER_ROLE_KEYWORDS.some(k => text.includes(k));
  return hasRole || hasActionableLenderRequest(subject, body);
}

function classify(subject, body, { hasPdf = false, from = '', pdfFilename = '', pdfFilenames = [] } = {}) {
  const text = `${subject} ${body}`.toLowerCase();
  const names = pdfFilenames.length ? pdfFilenames : (pdfFilename ? [pdfFilename] : []);

  if (isIgnorableEmail(subject, body))                         return 'IGNORE';
  if (isTitleOrClosingEmail(from, subject, body))              return 'OTHER';
  if (PRE_APPROVAL_KEYWORDS.some(k => text.includes(k)))       return 'PRE_APPROVAL';
  if (isNewrezApprovalEmail(from, subject))                    return 'CONDITION_LIST';
  if (isApprovalPdfCandidate(subject, body, { hasPdf, pdfFilename, pdfFilenames: names })) return 'CONDITION_LIST';
  if (isBrokerApprovalBundle(subject, body, { hasPdf, from, pdfFilenames: names })) return 'CONDITION_LIST';
  if (isLenderUrgentRequest(subject, body, from))              return 'LENDER_REQUEST';
  if (TASK_KEYWORDS.some(k => text.includes(k)))               return 'TASK';
  return 'OTHER';
}

module.exports = {
  classify,
  isUwmLoanSubject,
  isIgnorableEmail,
  isLenderUrgentRequest,
  isTitleOrClosingEmail,
  isKnownLenderEmployeeEmail,
  isApprovalPdfCandidate,
  isBrokerApprovalBundle,
  isClearToCloseSubject,
  isLoanDecisionEmail
};
