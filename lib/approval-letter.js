// Detect lender conditional approval PDFs vs closing/title correspondence.

const APPROVAL_MARKERS = [
  /LOAN APPROVAL CONDITIONS/i,
  /CONDITIONAL LOAN APPROVAL/i,
  /UNDERWRITING CONDITIONS/i,
  /PRIOR TO DOC(?:UMENTATION)?/i,
  /PRIOR TO FINAL APPROVAL/i,
  /CONDITIONS\s*-\s*\w+\s*-\s*\d{6,}/i,
  /APPROVAL LETTER/i,
  /U\.?\s*W\.?\s*M\.?\s*LOAN/i,
  /OPEN CONDITIONS/i
];

function looksLikeApprovalLetter(text) {
  const sample = (text ?? '').slice(0, 20000);
  if (sample.trim().length < 20) return false;
  return APPROVAL_MARKERS.some(re => re.test(sample));
}

function isApprovalPdfFilename(filename) {
  const name = (filename ?? '').toLowerCase();
  if (!name.endsWith('.pdf')) return false;
  if (/approvalletter|conditional.?approval|loan.?approval|approval.?letter|final.?approval/.test(name)) {
    return true;
  }
  if (/1003|1008|closing|settlement|alta|disclosure|invoice|wire|deed|note addendum/.test(name)) {
    return false;
  }
  return false;
}

module.exports = { looksLikeApprovalLetter, isApprovalPdfFilename, APPROVAL_MARKERS };
