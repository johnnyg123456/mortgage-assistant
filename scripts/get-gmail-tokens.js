require('dotenv').config();
const http  = require('http');
const https = require('https');
const url   = require('url');
const fs    = require('fs');
const path  = require('path');

const PORT         = 8080;
const REDIRECT_URI = `http://127.0.0.1:${PORT}`;
const SCOPES       = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify'
].join(' ');
const ENV_PATH = path.join(__dirname, '..', '.env');

const ACCOUNTS = [
  {
    label:        'John (Primary)',
    envKey:       'GMAIL_REFRESH_TOKEN_PRIMARY',
    clientId:     process.env.GMAIL_CLIENT_ID_PRIMARY,
    clientSecret: process.env.GMAIL_CLIENT_SECRET_PRIMARY,
  },
  {
    label:        'Christy (Secondary)',
    envKey:       'GMAIL_REFRESH_TOKEN_CHRISTY',
    clientId:     process.env.GMAIL_CLIENT_ID_CHRISTY,
    clientSecret: process.env.GMAIL_CLIENT_SECRET_CHRISTY,
  }
];

function buildAuthUrl(clientId) {
  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  REDIRECT_URI,
    response_type: 'code',
    scope:         SCOPES,
    access_type:   'offline',
    prompt:        'consent'
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

function exchangeCode(code, clientId, clientSecret) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      code,
      client_id:     clientId,
      client_secret: clientSecret,
      redirect_uri:  REDIRECT_URI,
      grant_type:    'authorization_code'
    }).toString();

    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path:     '/token',
      method:   'POST',
      headers:  {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function updateEnv(key, value) {
  let content = fs.readFileSync(ENV_PATH, 'utf8');
  const regex = new RegExp(`^(${key}=).*$`, 'm');
  content = regex.test(content)
    ? content.replace(regex, `$1${value}`)
    : content + `\n${key}=${value}`;
  fs.writeFileSync(ENV_PATH, content);
}

async function authorizeAccount(account) {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(` Authorizing: ${account.label}`);
  console.log('─'.repeat(50));
  console.log('\nOpen this URL in your browser:\n');
  console.log(buildAuthUrl(account.clientId));
  console.log('\nWaiting for redirect on port', PORT, '...\n');

  return new Promise((resolve, reject) => {
    const server = http.createServer();

    server.on('error', err => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${PORT} is in use. Run: npx kill-port ${PORT} then retry.`));
      } else {
        reject(err);
      }
    });

    server.on('request', async (req, res) => {
      const parsed = url.parse(req.url, true);
      const code   = parsed.query.code;
      const error  = parsed.query.error;

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<h2 style="font-family:sans-serif;color:red">Error: ${error ?? 'no code'}</h2>`);
        server.close();
        return reject(new Error(error ?? 'No auth code'));
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h2 style="font-family:sans-serif;padding:40px;color:green">✓ Authorized! You can close this tab and return to the terminal.</h2>');
      server.close();

      try {
        console.log('✓ Code received. Exchanging for refresh token...');
        const tokens = await exchangeCode(code, account.clientId, account.clientSecret);
        if (tokens.error) throw new Error(tokens.error_description ?? tokens.error);
        if (!tokens.refresh_token) throw new Error('No refresh_token in response');
        updateEnv(account.envKey, tokens.refresh_token);
        console.log(`✓ Saved to .env: ${account.envKey}`);
        resolve();
      } catch(err) {
        reject(err);
      }
    });

    server.listen(PORT, '127.0.0.1');
  });
}

async function main() {
  console.log('\n=== Gmail OAuth Token Generator ===');
  for (const account of ACCOUNTS) {
    try {
      await authorizeAccount(account);
    } catch (err) {
      console.error(`\n[ERROR] ${account.label}: ${err.message}`);
      process.exit(1);
    }
  }
  console.log('\n✓ Done — both refresh tokens saved to .env\n');
}

main();
