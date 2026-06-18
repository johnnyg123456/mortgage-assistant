require('dotenv').config();

const TOKEN = process.env.NOTION_TOKEN;
const LOANS_DB      = process.env.NOTION_LOANS_DB_ID;
const CONDITIONS_DB = process.env.NOTION_CONDITIONS_DB_ID;
const BASE = 'https://api.notion.com/v1';

const HEADERS = {
  'Authorization': `Bearer ${TOKEN}`,
  'Notion-Version': '2022-06-28',
  'Content-Type': 'application/json'
};

async function notionPatch(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PATCH',
    headers: HEADERS,
    body: JSON.stringify(body)
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.message ?? JSON.stringify(json));
  return json;
}

async function notionGet(path) {
  const res = await fetch(`${BASE}${path}`, { headers: HEADERS });
  const json = await res.json();
  if (!res.ok) throw new Error(json.message ?? JSON.stringify(json));
  return json;
}

function sel(options) {
  return { select: { options: options.map(n => ({ name: n })) } };
}

async function setupLoansDb() {
  console.log('\n[1/2] Creating Loans database fields...');
  await notionPatch(`/databases/${LOANS_DB}`, {
    title: [{ type: 'text', text: { content: 'Active Loans' } }],
    properties: {
      'Borrower Name': { title: {} },
      'Loan Number': { rich_text: {} },
      'Status': sel([
        'LOAN_SETUP','DISCLOSURE_SENT','UNDERWRITING_SUBMITTED',
        'APPROVED_WITH_CONDITIONS','RE_SUBMITTAL','CLEAR_TO_CLOSE',
        'DOCS_OUT','DOCS_SIGNED','SUSPENDED'
      ]),
      'Assigned To': sel(['You', 'Christy']),
      'LO Name':    { rich_text: {} },
      'Date Added': { date: {} }
    }
  });
  console.log('  Done.');
}

async function setupConditionsDb() {
  console.log('\n[2/2] Creating Conditions database fields...');
  await notionPatch(`/databases/${CONDITIONS_DB}`, {
    title: [{ type: 'text', text: { content: 'Conditions' } }],
    properties: {
      'Condition':  { title: {} },
      'Status':     sel(['Open', 'In Progress', 'Cleared']),
      'Borrower Last Name': { rich_text: {} },
      'Lender':     { rich_text: {} },
      'Loan': {
        relation: {
          database_id: LOANS_DB,
          single_property: {}
        }
      },
      'Assigned To': sel(['You', 'Christy']),
      'Source':      sel(['Underwriter', 'Realtor', 'Lender']),
      'Priority':    sel(['High', 'Medium', 'Low']),
      'Date Added':  { date: {} }
    }
  });
  console.log('  Done.');
}

async function verifyDatabase(dbId, label) {
  const db = await notionGet(`/databases/${dbId}`);
  const fields = Object.entries(db.properties ?? {})
    .map(([name, prop]) => `${name} (${prop.type})`);
  console.log(`\n  ✓ ${label}: "${db.title?.[0]?.plain_text ?? '(untitled)'}"`);
  console.log(`    Fields: ${fields.join(' | ')}`);
}

async function main() {
  console.log('=== Mortgage Bot — Notion Database Setup ===');
  if (!TOKEN)       { console.error('[ERROR] NOTION_TOKEN not set');       process.exit(1); }
  if (!LOANS_DB)    { console.error('[ERROR] NOTION_LOANS_DB_ID not set'); process.exit(1); }
  if (!CONDITIONS_DB) { console.error('[ERROR] NOTION_CONDITIONS_DB_ID not set'); process.exit(1); }

  await setupLoansDb();
  await setupConditionsDb();

  console.log('\n--- Verification ---');
  await verifyDatabase(LOANS_DB,      'Loans Database');
  await verifyDatabase(CONDITIONS_DB,  'Conditions Database');

  console.log('\n[OK] Both databases configured successfully.');
}

main().catch(err => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});
