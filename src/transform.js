import { classifyVariant } from './classify.js';

const GTIN_RE = /^\d{8,14}$/;

function numericId(gid) {
    return gid.split('/').pop();
}

function stripHtml(html) {
    return (html || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim();
}

function money(amount, currency) {
    return `${Number(amount).toFixed(2)} ${currency}`;
}

function isDefaultVariantTitle(title) {
    return !title || title === 'Default Title';
}

/**
 * Converts one Shopify productVariant GraphQL node into a single OpenAI feed row.
 * Returns { row } on success, or { skip: reason } when the variant can't be represented.
 */
export function transformVariant(variant, env) {
    const product = variant.product;
    const price = Number(variant.price);
    const compareAt = variant.compareAtPrice ? Number(variant.compareAtPrice) : null;

    const imageUrl = variant.image?.url || product.featuredImage?.url || null;
    const link = product.onlineStoreUrl
        ? `${product.onlineStoreUrl}?variant=${numericId(variant.id)}`
        : product.handle
            ? `${env.storefrontUrl}/products/${product.handle}?variant=${numericId(variant.id)}`
            : null;
    const description = stripHtml(product.descriptionHtml).slice(0, 5000);

    if (!imageUrl) return { skip: 'missing_image' };
    if (!link) return { skip: 'missing_link' };
    if (!price || price <= 0) return { skip: 'zero_or_missing_price' };
    if (!description) return { skip: 'empty_description' };
    if (product.status !== 'ACTIVE') return { skip: 'not_active' };

    const title = isDefaultVariantTitle(variant.title)
        ? product.title
        : `${product.title} - ${variant.title}`;

    const classification = classifyVariant(variant, price);

    const row = {
        item_id: numericId(variant.id),
        group_id: numericId(product.id),
        title: title.slice(0, 150),
        item_group_title: product.title.slice(0, 150),
        description,
        link,
        image_url: imageUrl,
        brand: (product.vendor || env.sellerName).slice(0, 70),
        availability: variant.availableForSale ? 'in_stock' : 'out_of_stock',
        price: compareAt && compareAt > price ? money(compareAt, env.currency) : money(price, env.currency),
        is_eligible_search: 'true',
        is_eligible_checkout: 'false',
        seller_name: env.sellerName,
        seller_url: env.storefrontUrl,
        target_countries: env.targetCountry,
        store_country: env.targetCountry,
        is_ads_eligible: 'true',
        condition: 'new',
        product_category: product.productType || '',
        listing_has_variations: (product.variantsCount?.count ?? 1) > 1 ? 'true' : 'false',
        variant_dict: variant.selectedOptions?.length
            ? JSON.stringify(Object.fromEntries(variant.selectedOptions.map((o) => [o.name, o.value])))
            : '',
        ...classification,
    };

    if (compareAt && compareAt > price) {
        row.sale_price = money(price, env.currency);
    }

    const gtinCandidate = (variant.barcode || '').replace(/[\s-]/g, '');
    if (GTIN_RE.test(gtinCandidate)) row.gtin = gtinCandidate;
    if (variant.sku) row.mpn = variant.sku.slice(0, 70);

    return { row };
}

export const FEED_COLUMNS = [
    'item_id', 'group_id', 'title', 'item_group_title', 'description', 'link', 'image_url',
    'brand', 'availability', 'price', 'sale_price', 'condition', 'gtin', 'mpn',
    'product_category', 'listing_has_variations', 'variant_dict',
    'is_eligible_search', 'is_eligible_checkout', 'seller_name', 'seller_url',
    'target_countries', 'store_country', 'is_ads_eligible', 'ads_metadata',
    'custom_label_0', 'custom_label_1', 'custom_label_2', 'custom_label_3', 'custom_label_4',
];
