require('dotenv').config();
const { runIfDue, buildDigestHtml } = require('../lib/digest-builder');
const { load: loadState, save: saveState } = require('../lib/state');
const { getClient, buildRawHtmlMessage } = require('../lib/gmail-client');

const DRY_RUN = process.env.DRY_RUN === 'true';

// GET /api/digest?force=true  — send digest now regardless of schedule
// GET /api/digest              — send only if a scheduled hour
module.exports = async (req, res) => {
  try {
    const force = req.query?.force === 'true';

    if (force) {
      const state        = loadState();
      const items        = state.pendingItems ?? [];
      const ignoredCount = state._ignoredCount ?? 0;

      if (!items.length) {
        return res.status(200).json({ ok: true, sent: false, reason: 'no-items' });
      }

      const gmail     = getClient();
      const johnEmail = process.env.JOHN_EMAIL;
      const urgent    = items.filter(i => i.category === 'URGENT').length;
      const respond   = items.filter(i => i.category === 'RESPOND').length;
      const subject   = urgent
        ? `[Digest] Now — ${urgent} urgent, ${respond} to respond`
        : `[Digest] Now — ${respond} to respond`;

      const html = buildDigestHtml(items, 'On-Demand', ignoredCount);

      if (!DRY_RUN) {
        const raw = buildRawHtmlMessage({ from: johnEmail, to: johnEmail, subject, html });
        await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
      }

      state.pendingItems  = [];
      state._ignoredCount = 0;
      saveState(state);

      return res.status(200).json({ ok: true, sent: true, itemCount: items.length });
    }

    const result = await runIfDue();
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
