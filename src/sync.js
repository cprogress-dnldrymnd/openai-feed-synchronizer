import 'dotenv/config';
import { gzipSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { stringify } from 'csv-stringify/sync';

import { fetchAllVariants } from './shopify.js';
import { transformVariant, FEED_COLUMNS } from './transform.js';
import { resetUnclassifiedCount, getUnclassifiedCount } from './classify.js';
import { validateRows, persistRowCount, spotCheckUrls } from './validate.js';
import { uploadFeed } from './sftp.js';

function parseArgs(argv) {
    const args = { dryRun: false, limit: null, skipUrlCheck: false };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--dry-run') args.dryRun = true;
        else if (argv[i] === '--skip-url-check') args.skipUrlCheck = true;
        else if (argv[i] === '--limit') args.limit = Number(argv[++i]);
    }
    return args;
}

function loadEnv() {
    const required = [
        'SHOPIFY_DOMAIN', 'SHOPIFY_ADMIN_ACCESS_TOKEN',
        'SFTP_HOST', 'SFTP_USERNAME', 'SFTP_UPLOAD_PATH',
    ];
    const missing = required.filter((key) => !process.env[key]);
    if (missing.length) {
        throw new Error(
            `Missing required env vars: ${missing.join(', ')}. Copy .env.example to .env and fill it in. ` +
            `SHOPIFY_ADMIN_ACCESS_TOKEN comes from running "npm run authorize" once.`
        );
    }
    if (!process.env.SFTP_PASSWORD && !process.env.PRIVATE_KEY_PATH) {
        throw new Error('Set either SFTP_PASSWORD or PRIVATE_KEY_PATH for SFTP authentication.');
    }
    if (process.env.SHOPIFY_DOMAIN.includes('coptrz.com') && !process.env.SHOPIFY_DOMAIN.includes('myshopify.com')) {
        throw new Error(
            `SHOPIFY_DOMAIN="${process.env.SHOPIFY_DOMAIN}" looks like the storefront domain. ` +
            `It must be the *.myshopify.com domain from the Dev Dashboard.`
        );
    }

    return {
        shopifyDomain: process.env.SHOPIFY_DOMAIN,
        shopifyAccessToken: process.env.SHOPIFY_ADMIN_ACCESS_TOKEN,
        sftpHost: process.env.SFTP_HOST,
        sftpPort: process.env.SFTP_PORT || '22',
        sftpUsername: process.env.SFTP_USERNAME,
        sftpUploadPath: process.env.SFTP_UPLOAD_PATH,
        privateKeyPath: process.env.PRIVATE_KEY_PATH,
        sftpPassword: process.env.SFTP_PASSWORD,
        storefrontUrl: (process.env.STOREFRONT_URL || 'https://coptrz.com').replace(/\/$/, ''),
        sellerName: process.env.SELLER_NAME || 'Coptrz',
        targetCountry: process.env.TARGET_COUNTRY || 'GB',
        currency: process.env.CURRENCY || 'GBP',
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const env = loadEnv();

    console.log(`[1/6] Using stored Admin API access token (${env.shopifyDomain})...`);

    console.log(`[2/6] Fetching product variants${args.limit ? ` (limit ${args.limit})` : ''}...`);
    const variants = await fetchAllVariants({
        domain: env.shopifyDomain,
        accessToken: env.shopifyAccessToken,
        limit: args.limit,
    });
    console.log(`      Retrieved ${variants.length} variant(s).`);

    console.log('[3/6] Transforming to OpenAI feed schema...');
    resetUnclassifiedCount();
    const rows = [];
    const skipped = {};
    for (const variant of variants) {
        const result = transformVariant(variant, env);
        if (result.skip) {
            skipped[result.skip] = (skipped[result.skip] || 0) + 1;
        } else {
            rows.push(result.row);
        }
    }
    console.log(`      ${rows.length} row(s) produced, ${variants.length - rows.length} skipped.`);
    if (Object.keys(skipped).length) {
        for (const [reason, count] of Object.entries(skipped)) console.log(`        - ${reason}: ${count}`);
    }
    console.log(`      Unclassified (missing product_line/use_case/bidding_tier): ${getUnclassifiedCount()}`);

    console.log('[4/6] Validating feed...');
    validateRows(rows, { checkDrop: !args.dryRun && !args.limit });
    if (!args.skipUrlCheck) {
        const warnings = await spotCheckUrls(rows);
        if (warnings.length) {
            console.log(`      URL spot-check warnings (${warnings.length}):`);
            warnings.forEach((w) => console.log(`        - ${w}`));
        } else {
            console.log('      URL spot-check passed.');
        }
    }

    const csv = stringify(rows, { header: true, columns: FEED_COLUMNS });
    const gz = gzipSync(Buffer.from(csv, 'utf8'));
    console.log(`      Feed built: ${rows.length} rows, ${(gz.length / 1024).toFixed(1)} KB gzipped.`);

    mkdirSync('./out', { recursive: true });
    writeFileSync('./out/coptrz_products.csv', csv);
    writeFileSync('./out/coptrz_products.csv.gz', gz);

    if (args.dryRun) {
        console.log('[5/6] Dry run — wrote ./out/coptrz_products.csv(.gz) instead of uploading.');
        console.log('[6/6] Done.');
        return;
    }

    console.log('[5/6] Uploading to OpenAI SFTP...');
    const { remotePath } = await uploadFeed(gz, env);
    console.log(`      Uploaded to ${remotePath}`);

    if (!args.limit) {
        persistRowCount(rows.length);
    }

    console.log('[6/6] Sync complete.');
}

main().catch((err) => {
    console.error('Sync failed:', err.message);
    process.exitCode = 1;
});
