import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const REQUIRED_FIELDS = [
    'item_id', 'title', 'description', 'link', 'image_url', 'brand', 'availability',
    'price', 'is_eligible_search', 'is_eligible_checkout', 'seller_name', 'seller_url',
    'target_countries', 'store_country',
];

const LIMITS = { title: 150, description: 5000, brand: 70, seller_name: 70, item_group_title: 150 };
const PRICE_RE = /^\d+\.\d{2} [A-Z]{3}$/;
const AVAILABILITY_VALUES = new Set(['in_stock', 'out_of_stock', 'pre_order', 'backorder', 'unknown']);
const BOOLEAN_FIELDS = ['is_eligible_search', 'is_eligible_checkout', 'is_ads_eligible', 'listing_has_variations'];

const STATE_PATH = new URL('../.feed-state.json', import.meta.url);

/**
 * Validates the full row set against the OpenAI feed spec before anything is uploaded.
 * Throws on any spec violation. Returns a summary object for logging.
 */
export function validateRows(rows, { checkDrop = true } = {}) {
    const errors = [];
    const seenIds = new Set();

    for (const [i, row] of rows.entries()) {
        for (const field of REQUIRED_FIELDS) {
            if (!row[field]) errors.push(`row ${i}: missing required field "${field}"`);
        }

        for (const [field, max] of Object.entries(LIMITS)) {
            if (row[field] && row[field].length > max) {
                errors.push(`row ${i}: "${field}" exceeds ${max} chars (${row[field].length})`);
            }
        }

        if (row.price && !PRICE_RE.test(row.price)) {
            errors.push(`row ${i}: "price" malformed: "${row.price}"`);
        }
        if (row.sale_price && !PRICE_RE.test(row.sale_price)) {
            errors.push(`row ${i}: "sale_price" malformed: "${row.sale_price}"`);
        }
        if (row.availability && !AVAILABILITY_VALUES.has(row.availability)) {
            errors.push(`row ${i}: invalid "availability": "${row.availability}"`);
        }
        for (const field of BOOLEAN_FIELDS) {
            if (row[field] !== undefined && row[field] !== '' && row[field] !== 'true' && row[field] !== 'false') {
                errors.push(`row ${i}: "${field}" must be "true"/"false", got "${row[field]}"`);
            }
        }
        if (row.item_id) {
            if (seenIds.has(row.item_id)) errors.push(`row ${i}: duplicate item_id "${row.item_id}"`);
            seenIds.add(row.item_id);
        }
    }

    if (errors.length) {
        const preview = errors.slice(0, 25).join('\n  ');
        throw new Error(`Feed validation failed with ${errors.length} error(s):\n  ${preview}`);
    }

    if (checkDrop) checkRowCountDrop(rows.length);

    return { rowCount: rows.length };
}

function checkRowCountDrop(currentCount) {
    let previousCount = null;
    if (existsSync(STATE_PATH)) {
        try {
            previousCount = JSON.parse(readFileSync(STATE_PATH, 'utf8')).rowCount;
        } catch {
            previousCount = null;
        }
    }

    if (previousCount && currentCount < previousCount * 0.8) {
        throw new Error(
            `Row count dropped ${previousCount} -> ${currentCount} (>20%). Aborting upload — ` +
            `this usually means an auth/query regression, not a real catalogue change. ` +
            `Delete .feed-state.json to override if this drop is expected.`
        );
    }
}

export function persistRowCount(rowCount) {
    writeFileSync(STATE_PATH, JSON.stringify({ rowCount, updatedAt: new Date().toISOString() }, null, 2));
}

// coptrz.com sits behind Cloudflare, which gateway-times-out HEAD requests that don't
// carry a browser-like User-Agent (fetch's default UA gets a 504, not a real block).
const SPOT_CHECK_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Spot-checks a sample of link/image_url values resolve with HTTP 200.
 * Non-fatal — logs warnings rather than throwing, since transient 5xxs shouldn't block a sync.
 */
export async function spotCheckUrls(rows, { sampleSize = 20 } = {}) {
    const sample = rows
        .filter((_, i) => i % Math.max(1, Math.floor(rows.length / sampleSize)) === 0)
        .slice(0, sampleSize);

    const warnings = [];
    for (const row of sample) {
        for (const field of ['link', 'image_url']) {
            try {
                const res = await fetch(row[field], {
                    method: 'HEAD',
                    redirect: 'follow',
                    headers: { 'User-Agent': SPOT_CHECK_USER_AGENT },
                });
                if (!res.ok) warnings.push(`${field} "${row[field]}" returned HTTP ${res.status}`);
            } catch (err) {
                warnings.push(`${field} "${row[field]}" fetch failed: ${err.message}`);
            }
        }
    }
    return warnings;
}
