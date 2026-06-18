const https = require('https');
const http = require('http');

const NEWREZ_FROM_RE = /notify@myaccount\.newrez\.com/i;
const NEWREZ_SUBJECT_RE = /approval for loan\s*#?\s*(\d+)/i;
const PDF_LINK_RE = /Loan[_\s-]?Approval\.pdf/i;

function isNewrezApprovalEmail(from, subject) {
  if (!NEWREZ_FROM_RE.test(from ?? '')) return false;
  return NEWREZ_SUBJECT_RE.test(subject ?? '');
}

function extractLoanNumberFromSubject(subject) {
  const m = (subject ?? '').match(NEWREZ_SUBJECT_RE);
  return m ? m[1] : null;
}

function decodeHtmlEntities(str) {
  return (str ?? '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function extractApprovalPdfUrl(html, plainBody, subject) {
  const loanNumber = extractLoanNumberFromSubject(subject);
  const sources = [html, plainBody].filter(Boolean);

  for (const source of sources) {
    const decoded = decodeHtmlEntities(source);

    for (const m of decoded.matchAll(/href=["']([^"']+)["']/gi)) {
      const url = m[1].trim();
      if (!PDF_LINK_RE.test(url)) continue;
      if (loanNumber && !url.includes(loanNumber)) continue;
      return url;
    }

    for (const m of decoded.matchAll(/https?:\/\/[^\s"'<>]+\.pdf/gi)) {
      const url = m[0].trim();
      if (!PDF_LINK_RE.test(url)) continue;
      if (loanNumber && !url.includes(loanNumber)) continue;
      return url;
    }
  }

  return null;
}

function fetchBuffer(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));

    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'MortgageBot/1.0' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const next = new URL(res.headers.location, url).href;
        res.resume();
        return resolve(fetchBuffer(next, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
  });
}

async function downloadApprovalPdf(url) {
  const buf = await fetchBuffer(url);
  if (buf.slice(0, 4).toString() !== '%PDF') {
    throw new Error('Downloaded file is not a PDF');
  }
  return buf;
}

module.exports = {
  isNewrezApprovalEmail,
  extractLoanNumberFromSubject,
  extractApprovalPdfUrl,
  downloadApprovalPdf
};
