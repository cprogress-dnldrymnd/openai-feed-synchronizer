import 'dotenv/config';
import { createServer } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * One-time interactive OAuth authorization code grant.
 *
 * client_credentials grant is blocked on live/production Shopify stores
 * (Shopify only allows it on dev stores in the same org — see shop_not_permitted).
 * For a production store, the supported server-to-server path is: authorize once
 * as a store admin, exchange the resulting code for a permanent OFFLINE access
 * token, then use that static token forever. Custom/internal apps (this one) are
 * exempt from Shopify's new expiring-token requirement, so no refresh logic is
 * needed — run this script once, paste the printed token into .env, done.
 *
 * Before running:
 *   1. In the Dev Dashboard, open the OpenAI Feed Synchronizer app -> Configuration.
 *   2. Add http://localhost:8787/callback to "Allowed redirection URL(s)".
 *   3. Confirm the app's Admin API scopes include read_products and read_inventory.
 */

const PORT = 8787;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPES = process.env.SHOPIFY_SCOPES || 'read_products,read_inventory';

const domain = process.env.SHOPIFY_DOMAIN;
const clientId = process.env.SHOPIFY_CLIENT_ID;
const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

if (!domain || !clientId || !clientSecret) {
    console.error('Missing SHOPIFY_DOMAIN / SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET in .env');
    process.exit(1);
}

const state = randomBytes(16).toString('hex');

function verifyHmac(query) {
    const { hmac, ...rest } = query;
    if (!hmac) return false;
    const message = Object.keys(rest)
        .sort()
        .map((key) => `${key}=${Array.isArray(rest[key]) ? rest[key].join(',') : rest[key]}`)
        .join('&');
    const digest = createHmac('sha256', clientSecret).update(message).digest('hex');
    const a = Buffer.from(digest, 'utf8');
    const b = Buffer.from(hmac, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
}

async function exchangeCodeForToken(code) {
    const res = await fetch(`https://${domain}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    });
    if (!res.ok) {
        throw new Error(`Token exchange failed (${res.status}): ${await res.text()}`);
    }
    return res.json();
}

const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
    }

    const query = Object.fromEntries(url.searchParams.entries());

    if (query.state !== state) {
        res.writeHead(400).end('State mismatch — possible CSRF, aborting.');
        server.close();
        console.error('State mismatch on callback. Aborting.');
        process.exit(1);
    }

    if (!verifyHmac(query)) {
        res.writeHead(400).end('HMAC verification failed.');
        server.close();
        console.error('HMAC verification failed on callback. Aborting.');
        process.exit(1);
    }

    try {
        const token = await exchangeCodeForToken(query.code);
        res.writeHead(200, { 'Content-Type': 'text/html' }).end(
            '<h2>Authorized.</h2><p>Access token printed in your terminal. You can close this tab.</p>'
        );
        console.log('\nAuthorization successful.');
        console.log('Granted scopes:', token.scope);
        console.log('\nAdd this to .env:');
        console.log(`SHOPIFY_ADMIN_ACCESS_TOKEN=${token.access_token}`);
        console.log('\nThis token does not expire (custom/internal app). Keep it secret.');
    } catch (err) {
        res.writeHead(500).end('Token exchange failed — see terminal.');
        console.error(err.message);
    } finally {
        server.close();
        process.exit(0);
    }
});

server.listen(PORT, () => {
    const authorizeUrl =
        `https://${domain}/admin/oauth/authorize?` +
        new URLSearchParams({
            client_id: clientId,
            scope: SCOPES,
            redirect_uri: REDIRECT_URI,
            state,
        });

    console.log('Open this URL in a browser where you are logged in as a store admin:\n');
    console.log(authorizeUrl.toString());
    console.log(`\nWaiting for callback on ${REDIRECT_URI} ...`);
});
