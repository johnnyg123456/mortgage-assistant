const { queryDatabase, createPage, archivePage } = require('./notion-client');
const { LOAN_NUMBER_PROPERTY, LENDER_PROPERTY } = require('./notion-schema');

const LOANS_DB = process.env.NOTION_LOANS_DB_ID;
const CONDITIONS_DB = process.env.NOTION_CONDITIONS_DB_ID;

function normalizeLoanNumber(raw) {
  return (raw ?? '').toString().trim().replace(/\s+/g, ' ');
}

function loanNumbersMatch(emailNum, notionNum) {
  const a = normalizeLoanNumber(emailNum).replace(/\D/g, '');
  const b = normalizeLoanNumber(notionNum).replace(/\D/g, '');
  if (!a || !b) return false;
  return a === b || b.endsWith(a) || a.endsWith(b);
}

function getLoanNumberFromPage(loan) {
  return loan.properties?.[LOAN_NUMBER_PROPERTY]?.rich_text?.[0]?.plain_text ?? '';
}

async function finalizeClearToCloseLoan(loan) {
  const conditions = await queryDatabase(CONDITIONS_DB, {
    property: 'Loan', relation: { contains: loan.id }
  });

  for (const cond of conditions.results) {
    await archivePage(cond.id);
  }
  await archivePage(loan.id);

  return {
    loanNumber: getLoanNumberFromPage(loan),
    conditionsArchived: conditions.results.length
  };
}

// Search order: lender loan number first, borrower name second.
async function findLoanByNumberOrBorrower(loanNumber, borrowerName) {
  const loanId = normalizeLoanNumber(loanNumber);
  if (loanId) {
    const exact = await queryDatabase(LOANS_DB, {
      property: LOAN_NUMBER_PROPERTY, rich_text: { equals: loanId }
    });
    if (exact.results.length) return exact.results[0];

    const partial = await queryDatabase(LOANS_DB, {
      property: LOAN_NUMBER_PROPERTY, rich_text: { contains: loanId }
    });
    if (partial.results.length) return partial.results[0];
  }

  const borrower = borrowerName?.trim();
  if (borrower) {
    const full = await queryDatabase(LOANS_DB, {
      property: 'Borrower Name', title: { contains: borrower }
    });
    if (full.results.length) return full.results[0];

    const parts = borrower.split(/\s+/);
    if (parts.length >= 2) {
      const byLast = await queryDatabase(LOANS_DB, {
        property: 'Borrower Name', title: { contains: parts[parts.length - 1] }
      });
      if (byLast.results.length === 1) return byLast.results[0];
    }

    const byFirst = await queryDatabase(LOANS_DB, {
      property: 'Borrower Name', title: { contains: parts[0] }
    });
    if (byFirst.results.length === 1) return byFirst.results[0];
  }

  return null;
}

async function createLoanFromApproval({ borrowerName, loanNumber, lenderName }) {
  const loanId = normalizeLoanNumber(loanNumber);
  const title = borrowerName?.trim() || (loanId ? `Loan ${loanId}` : 'Unknown Borrower');

  const props = {
    'Borrower Name': { title: [{ text: { content: title } }] },
    [LOAN_NUMBER_PROPERTY]: { rich_text: [{ text: { content: loanId } }] },
    'LO Name':       { rich_text: [{ text: { content: '' } }] },
    'Status':        { select: { name: 'APPROVED_WITH_CONDITIONS' } },
    'Date Added':    { date: { start: new Date().toISOString().split('T')[0] } }
  };
  if (lenderName) {
    props[LENDER_PROPERTY] = { rich_text: [{ text: { content: lenderName } }] };
  }

  return createPage(LOANS_DB, props);
}

async function findOrCreateLoanFromApproval({ borrowerName, loanNumber, lenderName }) {
  const loanId = normalizeLoanNumber(loanNumber);
  const existing = await findLoanByNumberOrBorrower(loanId, borrowerName);
  if (existing) return { loan: existing, created: false };

  if (!borrowerName?.trim() && !loanId) {
    return { loan: null, created: false };
  }

  const loan = await createLoanFromApproval({ borrowerName, loanNumber: loanId, lenderName });
  return { loan, created: true };
}

module.exports = {
  findLoanByNumberOrBorrower,
  createLoanFromApproval,
  findOrCreateLoanFromApproval,
  loanNumbersMatch,
  getLoanNumberFromPage,
  finalizeClearToCloseLoan,
  normalizeLoanNumber
};
