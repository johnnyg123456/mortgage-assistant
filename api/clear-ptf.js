require('dotenv').config();
const { clearPtfConditionsForLoan } = require('../lib/condition-parser');

module.exports = async (req, res) => {
  const borrower   = req.query.borrower || 'George';
  const loanNumber = req.query.loan    || null;

  try {
    const result = await clearPtfConditionsForLoan(borrower, loanNumber);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), action: 'clear-ptf-error', error: err.message }));
    return res.status(500).json({ ok: false, error: err.message });
  }
};
