const fs = require('fs');
const path = require('path');

const STATE_FILE = process.env.STATE_FILE
  || (process.env.VERCEL ? '/tmp/.broker-state.json' : path.join(__dirname, '..', 'data', 'state.json'));

function load() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { processedIds: [], lastDigestHour: null, pendingItems: [] }; }
}

function save(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// Keep processed IDs list from growing unboundedly — keep last 2000
function pruneProcessed(state) {
  if (state.processedIds.length > 2000) {
    state.processedIds = state.processedIds.slice(-2000);
  }
  return state;
}

module.exports = { load, save, pruneProcessed };
