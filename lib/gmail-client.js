require('dotenv').config();
const { google } = require('googleapis');

function makeGmailClient(clientId, clientSecret, refreshToken) {
  const auth = new google.auth.OAuth2(clientId, clientSecret, 'http://127.0.0.1:8080');
  auth.setCredentials({ refresh_token: refreshToken });
  return google.gmail({ version: 'v1', auth });
}

function getEbotClient() {
  if (!process.env.GMAIL_REFRESH_TOKEN_EBOT) return null;
  return makeGmailClient(
    process.env.GMAIL_CLIENT_ID_EBOT,
    process.env.GMAIL_CLIENT_SECRET_EBOT,
    process.env.GMAIL_REFRESH_TOKEN_EBOT
  );
}

function getClients() {
  return {
    primary: {
      label: 'John',
      email: process.env.JOHN_EMAIL,
      isJohn: true,
      gmail: makeGmailClient(
        process.env.GMAIL_CLIENT_ID_PRIMARY,
        process.env.GMAIL_CLIENT_SECRET_PRIMARY,
        process.env.GMAIL_REFRESH_TOKEN_PRIMARY
      )
    },
    christy: {
      label: 'Christy',
      email: process.env.CHRISTINA_EMAIL,
      isJohn: false,
      gmail: makeGmailClient(
        process.env.GMAIL_CLIENT_ID_CHRISTY,
        process.env.GMAIL_CLIENT_SECRET_CHRISTY,
        process.env.GMAIL_REFRESH_TOKEN_CHRISTY
      )
    }
  };
}

function extractPart(payload, mimeType) {
  function search(part) {
    if (part.mimeType === mimeType && part.body?.data)
      return Buffer.from(part.body.data, 'base64').toString('utf8');
    for (const child of part.parts ?? []) { const r = search(child); if (r) return r; }
    return null;
  }
  return search(payload);
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractBody(payload) {
  const plain = extractPart(payload, 'text/plain');
  if (plain) return plain;
  const html = extractPart(payload, 'text/html');
  if (html) return stripHtml(html);
  return '';
}

function getHeader(headers, name) {
  return (headers ?? []).find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function encodeMimeHeader(value) {
  const text = (value ?? '').toString();
  if (!text || /^[\x00-\x7F]*$/.test(text)) return text;
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  return `=?UTF-8?B?${b64}?=`;
}

function buildRawMessage({ from, to, subject, body, inReplyTo, references }) {
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeMimeHeader(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit'
  ];
  if (inReplyTo) {
    lines.push(`In-Reply-To: ${inReplyTo}`);
    lines.push(`References: ${references || inReplyTo}`);
  }
  lines.push('', body);
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

function buildRawHtmlMessage({ from, to, subject, html, inReplyTo, references }) {
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeMimeHeader(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit'
  ];
  if (inReplyTo) {
    lines.push(`In-Reply-To: ${inReplyTo}`);
    lines.push(`References: ${references || inReplyTo}`);
  }
  lines.push('', html);
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

module.exports = { getClients, getEbotClient, extractBody, getHeader, buildRawMessage, buildRawHtmlMessage };
