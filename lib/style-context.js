const fs = require('fs');
const path = require('path');

const CONTEXT_FILE = path.join(__dirname, '..', 'data', 'style-context.json');

const FALLBACK = {
  tone: 'Professional and direct. Keep responses concise. Sign off as John.',
  toneByAudience: {},
  typicalLength: '1-3 sentences',
  greetings: [],
  signOffs: ['Thanks,'],
  sampleSignOff: 'Thanks,',
  recurringPhrases: [],
  importantSenders: [],
  ignorePatterns: [
    'lock confirmation', 'lock update', 'rate lock', 'change of circumstance',
    'coc notice', 'missing items for loan submission', 'recall:',
    'noreply', 'no-reply', 'donotreply', 'notifications@'
  ],
  urgentKeywords: [
    'urgent', 'asap', 'today', 'by eod', 'end of day', 'time sensitive',
    'expires', 'expiring', 'expired', 'suspended', 'denied', 'declined',
    'closing tomorrow', 'closing today', 'clear to close', 'ctc'
  ],
  learnedAt: null
};

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf8'));
    return { ...FALLBACK, ...raw };
  } catch {
    return FALLBACK;
  }
}

// Detect recipient audience from the email's "from" address and body context
function detectAudience(email) {
  const t = `${email.from ?? ''} ${email.subject ?? ''} ${(email.body ?? '').slice(0, 300)}`.toLowerCase();
  if (/uwm|newrez|acralending|amwest|nationsdirect|archome|cakemortgage|theloanstore|bluepoint|fundloans|orion|pennymac|prmg|loanstream|resicentral|emporiumtpo/.test(t)) return 'lender';
  if (/mytitleco|lawflorida|horizonabstract|homepartnerstitle|titleco|escrow|closing|settlement/.test(t)) return 'title';
  if (/realtor|realty|real estate|remax|keller|coldwell|berkshire/.test(t)) return 'realtor';
  if (/libertygroupfunding/.test(email.from ?? '')) return 'internal';
  if (/gmail|yahoo|hotmail|outlook|icloud|aol/.test(email.from ?? '')) return 'client';
  return 'client'; // default to client tone for unknown senders
}

function buildSystemPrompt(ctx, email) {
  const audience = email ? detectAudience(email) : null;
  const audienceTone = (audience && ctx.toneByAudience?.[audience])
    ? `\nTONE FOR THIS RECIPIENT TYPE (${audience.toUpperCase()}):\n${ctx.toneByAudience[audience]}`
    : '';

  const greetings = (ctx.greetings ?? []).length
    ? `Greetings John uses: ${ctx.greetings.join(', ')}`
    : 'John rarely uses greetings — gets straight to the point.';

  const signOffs = (ctx.signOffs ?? []).length
    ? `Sign-offs John uses: ${ctx.signOffs.join(', ')}`
    : `Sign-off: ${ctx.sampleSignOff}`;

  const phrases = (ctx.recurringPhrases ?? []).length
    ? `\nPHRASES JOHN ACTUALLY USES:\n${ctx.recurringPhrases.join(', ')}`
    : '';

  return `You are drafting email replies for John, a mortgage broker at Liberty Group Funding.

JOHN'S OVERALL VOICE:
${ctx.tone}

TYPICAL LENGTH: ${ctx.typicalLength || '1-3 sentences — rarely longer'}
${audienceTone}

${greetings}
${signOffs}
${phrases}

CRITICAL RULES:
- Match John's actual voice exactly — do NOT sound like a generic professional email
- Keep it short. John does not write paragraphs.
- Do not add filler: no "I hope this finds you well", no "Please don't hesitate to reach out"
- Do not restate what the other person said
- If John would just say "Sent" or "On it" — write that
- End with the appropriate sign-off, then just "John" (no full signature block)`;
}

module.exports = { load, buildSystemPrompt, detectAudience };
