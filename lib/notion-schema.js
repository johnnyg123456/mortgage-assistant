// Property names in the live Notion databases.
const LOAN_NUMBER_PROPERTY = process.env.NOTION_LOAN_NUMBER_PROPERTY || 'Loan Number';
const BORROWER_LAST_NAME_PROPERTY = process.env.NOTION_BORROWER_LAST_NAME_PROPERTY || 'Borrower Last Name';
const LENDER_PROPERTY = process.env.NOTION_LENDER_PROPERTY || 'Lender';

module.exports = {
  LOAN_NUMBER_PROPERTY,
  BORROWER_LAST_NAME_PROPERTY,
  LENDER_PROPERTY
};
