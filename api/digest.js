require('dotenv').config();
const { runIfDue } = require('../lib/digest-builder');
const { load: loadState, save: saveState } = require('../lib/state');
const { getClient, buildRawMessage } = require('../lib/gmail-client');
const { buildDigestEmail } = require('../lib/digest-builder');

const DRY_RUN = process.env.DRY_RUN === 'true';

// GET /api/digest?force=true  — send digest now regardless of schedule
// GET /api/digest              — send only if a scheduled hour
module.exports = async (req, res) => {
  try {
    const force = req.query?.force === 'true';

    if (force) {
      const state = loadState();
      const items = state.pendingItems ?? [];

      if (!items.length) {
        return res.status(200).json({ ok: true, sent: false, reason: 'no-items' });
      }

      const gmail = getClient();
      const johnEmail = process.env.JOHN_EMAIL;
      const subject = `[Broker Assistant] Digest — ${items.filter(i => i.category === 'URGENT').length} urgent, ${items.filter(i => i.category === 'RESPOND').length} to respond`;
      items._ignoredCount = state._ignoredCount ?? 0;
      const body = buildDigestEmail(items);

      if (!DRY_RUN) {
        const raw = buildRawMessage({ from: johnEmail, to: johnEmail, subject, body });
        await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
      }

      state.pendingItems = [];
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
