import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rules = JSON.parse(
    readFileSync(path.join(__dirname, '..', 'config', 'classification.json'), 'utf8')
);

let unclassifiedCount = 0;

function metafield(product, key) {
    const node = product.metafields?.nodes?.find((m) => m.key === key);
    return node?.value?.trim() || null;
}

function tagValue(product, prefix) {
    const tag = (product.tags || []).find((t) => t.toLowerCase().startsWith(prefix));
    return tag ? tag.slice(prefix.length).trim() : null;
}

function bandFor(price, bands, field) {
    for (const band of bands) {
        if (band.maxPrice === null || price <= band.maxPrice) return band[field];
    }
    return null;
}

/**
 * Resolves the four ad-group filtering values for a variant, in priority order:
 * 1. Shopify metafield (marketing-editable, no redeploy)
 * 2. Tag prefix (line:xxx / usecase:xxx)
 * 3. Static rules in config/classification.json
 * 4. "unclassified" — never guessed silently
 */
export function classifyVariant(variant, price) {
    const product = variant.product;

    const productLine =
        metafield(product, 'product_line') ||
        tagValue(product, 'line:') ||
        rules.productTypeToProductLine[product.productType] ||
        'unclassified';

    const useCase =
        metafield(product, 'use_case') ||
        tagValue(product, 'usecase:') ||
        rules.vendorToUseCase[product.vendor] ||
        'unclassified';

    const brand = (product.vendor || 'unclassified').toLowerCase();

    const biddingTier =
        metafield(product, 'bidding_tier') ||
        bandFor(price, rules.biddingTierPriceBandsGBP, 'tier') ||
        'unclassified';

    const priceBand = bandFor(price, rules.priceBandsGBP, 'label') || 'unclassified';

    if ([productLine, useCase, biddingTier].includes('unclassified')) {
        unclassifiedCount += 1;
    }

    return {
        custom_label_0: productLine,
        custom_label_1: useCase,
        custom_label_2: brand,
        custom_label_3: biddingTier,
        custom_label_4: priceBand,
        ads_metadata: JSON.stringify({
            product_line: productLine,
            use_case: useCase,
            brand,
            bidding_tier: biddingTier,
        }),
    };
}

export function getUnclassifiedCount() {
    return unclassifiedCount;
}

export function resetUnclassifiedCount() {
    unclassifiedCount = 0;
}
