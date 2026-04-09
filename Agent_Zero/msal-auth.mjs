// msal-auth.mjs — MSAL Node.js authentication with WAM NativeBrokerPlugin.
// Uses Windows Integrated Auth (Kerberos) — zero popups, zero account pickers.
// The workiq native binary has a bug where it shows the WAM account picker for
// every query. This module replaces it with proper silent WAM auth via NativeBrokerPlugin.

import { PublicClientApplication, LogLevel } from '@azure/msal-node';
import { NativeBrokerPlugin } from '@azure/msal-node-extensions';

// Same client ID as the workiq native binary
const CLIENT_ID = 'ba081686-5d24-4bc6-a0d6-d034ecffed87';
const SCOPES = ['https://graph.microsoft.com/.default'];
const ACCOUNT_HINT = 'martih@microsoft.com';

const nativeBrokerPlugin = new NativeBrokerPlugin();

const pca = new PublicClientApplication({
  auth: {
    clientId: CLIENT_ID,
    authority: 'https://login.microsoftonline.com/common',
  },
  broker: { nativeBrokerPlugin },
  system: {
    loggerOptions: {
      loggerCallback: (level, message) => {
        if (level <= LogLevel.Warning) console.log(`[MSAL] ${message}`);
      },
      logLevel: LogLevel.Warning,
    },
  },
});

// Serialize concurrent auth requests
let activeAuthPromise = null;

/**
 * Get a valid access token for Microsoft Graph via WAM (Windows Integrated Auth).
 * Uses NativeBrokerPlugin which authenticates silently via Kerberos — no popups.
 */
export async function getGraphToken() {
  if (activeAuthPromise) return activeAuthPromise;

  // Try silent first (from in-memory + WAM cache)
  const accounts = await pca.getTokenCache().getAllAccounts();
  if (accounts.length > 0) {
    const account = accounts.find(a => a.username === ACCOUNT_HINT) || accounts[0];
    try {
      const result = await pca.acquireTokenSilent({ scopes: SCOPES, account });
      return result.accessToken;
    } catch {}
  }

  // Interactive via WAM — uses WindowsIntegratedAuth (Kerberos), no popup
  activeAuthPromise = pca.acquireTokenInteractive({
    scopes: SCOPES,
    loginHint: ACCOUNT_HINT,
  }).then((result) => {
    activeAuthPromise = null;
    return result.accessToken;
  }).catch((err) => {
    activeAuthPromise = null;
    throw err;
  });

  return activeAuthPromise;
}

/**
 * Search Microsoft 365 emails and Teams messages.
 * Combines Graph Search API (keyword search) with direct mailbox/chat queries
 * (date-filtered) for comprehensive results. Returns human-readable text.
 */
export async function searchM365(question) {
  const token = await getGraphToken();

  // Extract date hints from the question (e.g., "last 4 days", "since April 4")
  const now = new Date();
  let sinceDate = null;
  const daysMatch = question.match(/last\s+(\d+)\s+days?/i);
  const sinceMatch = question.match(/since\s+([\w\s,]+\d{4})/i);
  if (daysMatch) {
    sinceDate = new Date(now - parseInt(daysMatch[1]) * 86400000);
  } else if (sinceMatch) {
    const parsed = new Date(sinceMatch[1]);
    if (!isNaN(parsed)) sinceDate = parsed;
  }
  if (!sinceDate) {
    // Default: last 7 days for broad queries
    sinceDate = new Date(now - 7 * 86400000);
  }
  const sinceISO = sinceDate.toISOString();
  const sinceShort = sinceISO.split('T')[0];

  // Extract keywords (strip filler words but keep nouns/names)
  const keywords = question
    .replace(/\b(show|find|search|get|list|what|which|are|is|my|me|all|the|from|about|for|in|of|to|do|i|have|has|any|new|recent|latest|messages?|emails?|teams?|chats?|threads?|conversations?|received|sent|need|require|action|response|pending|please|every|each|exact|sorted|unread|inbox)\b/gi, '')
    .replace(/\b(last|past|since|after|before|during|days?|weeks?|months?)\b/gi, '')
    .replace(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/gi, '')
    .replace(/\b\d{4}\b/g, '')
    .replace(/["'""„]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
  const items = [];

  // Strategy 1: Direct mailbox query (date-filtered, most reliable for recent mail)
  try {
    const mailUrl = `https://graph.microsoft.com/v1.0/me/messages?$filter=receivedDateTime ge ${sinceISO}&$top=20&$select=subject,from,toRecipients,receivedDateTime,bodyPreview,webLink&$orderby=receivedDateTime desc`;
    const mailRes = await fetch(mailUrl, { headers });
    if (mailRes.ok) {
      const mailData = await mailRes.json();
      for (const m of (mailData.value || [])) {
        items.push({
          type: 'email',
          from: m.from?.emailAddress?.name || m.from?.emailAddress?.address || 'unknown',
          to: (m.toRecipients || []).map(r => r.emailAddress?.name || r.emailAddress?.address).join(', '),
          date: m.receivedDateTime || '',
          subject: m.subject || '',
          summary: (m.bodyPreview || '').substring(0, 300),
          link: m.webLink || null,
        });
      }
    }
  } catch {}

  // Strategy 2: Graph Search for Teams messages (with date filter via KQL)
  try {
    const chatQuery = keywords.length > 3 ? `${keywords} created>=${sinceShort}` : `created>=${sinceShort}`;
    const chatRes = await fetch('https://graph.microsoft.com/v1.0/search/query', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        requests: [{
          entityTypes: ['chatMessage'],
          query: { queryString: chatQuery },
          from: 0,
          size: 15,
        }],
      }),
    });
    if (chatRes.ok) {
      const chatData = await chatRes.json();
      for (const sr of (chatData.value || [])) {
        for (const hc of (sr.hitsContainers || [])) {
          for (const hit of (hc.hits || [])) {
            const r = hit.resource || {};
            items.push({
              type: 'teams',
              from: r.from?.user?.displayName || r.from?.application?.displayName || 'unknown',
              date: r.createdDateTime || '',
              summary: (hit.summary || r.body?.content || '').replace(/<[^>]*>/g, '').substring(0, 300),
              link: r.webLink || null,
            });
          }
        }
      }
    }
  } catch {}

  // Strategy 3: Keyword search for emails (supplements direct query with relevance ranking)
  if (keywords.length > 3) {
    try {
      const emailQuery = `${keywords} received>=${sinceShort}`;
      const emailRes = await fetch('https://graph.microsoft.com/v1.0/search/query', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          requests: [{
            entityTypes: ['message'],
            query: { queryString: emailQuery },
            from: 0,
            size: 10,
          }],
        }),
      });
      if (emailRes.ok) {
        const emailData = await emailRes.json();
        for (const sr of (emailData.value || [])) {
          for (const hc of (sr.hitsContainers || [])) {
            for (const hit of (hc.hits || [])) {
              const r = hit.resource || {};
              const subject = r.subject || '';
              // Avoid duplicates from direct mailbox query
              if (!items.some(i => i.type === 'email' && i.subject === subject)) {
                items.push({
                  type: 'email',
                  from: r.from?.emailAddress?.name || r.from?.emailAddress?.address || 'unknown',
                  to: (r.toRecipients || []).map(t => t.emailAddress?.name || t.emailAddress?.address).join(', '),
                  date: r.receivedDateTime || r.createdDateTime || '',
                  subject,
                  summary: (hit.summary || r.bodyPreview || '').substring(0, 300),
                  link: r.webLink || null,
                });
              }
            }
          }
        }
      }
    } catch {}
  }

  if (items.length === 0) {
    return 'No results found for this search query.';
  }

  // Sort by date (newest first)
  items.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

  // Format as human-readable text
  const lines = items.map((item, i) => {
    if (item.type === 'email') {
      return `${i + 1}. EMAIL — From: ${item.from} | To: ${item.to} | Date: ${item.date} | Subject: ${item.subject}\n   Preview: ${item.summary}${item.link ? '\n   Link: ' + item.link : ''}`;
    } else {
      return `${i + 1}. TEAMS — From: ${item.from} | Date: ${item.date}\n   Message: ${item.summary}${item.link ? '\n   Link: ' + item.link : ''}`;
    }
  });

  return `Found ${items.length} results (since ${sinceShort}):\n\n${lines.join('\n\n')}`;
}
