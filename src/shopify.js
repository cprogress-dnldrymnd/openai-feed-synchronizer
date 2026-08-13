const API_VERSION = '2026-07';

const PRODUCT_VARIANTS_QUERY = `
query ProductVariants($cursor: String) {
  productVariants(first: 250, after: $cursor, query: "product_status:active") {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      sku
      barcode
      title
      price
      compareAtPrice
      availableForSale
      selectedOptions { name value }
      image { url }
      product {
        id
        title
        descriptionHtml
        handle
        onlineStoreUrl
        vendor
        productType
        tags
        status
        featuredImage { url }
        metafields(namespace: "custom", first: 10) {
          nodes { key value }
        }
        variantsCount { count }
      }
    }
  }
}`;

/**
 * Fetches every active product variant via cursor pagination, respecting Shopify's
 * GraphQL cost throttling (sleeps and retries when the query cost budget is exhausted).
 */
export async function fetchAllVariants({ domain, accessToken, limit }) {
    const endpoint = `https://${domain}/admin/api/${API_VERSION}/graphql.json`;
    const variants = [];
    let cursor = null;
    let hasNextPage = true;

    while (hasNextPage) {
        const result = await runGraphQL(endpoint, accessToken, PRODUCT_VARIANTS_QUERY, { cursor });
        const page = result.data.productVariants;

        for (const node of page.nodes) {
            variants.push(node);
            if (limit && variants.length >= limit) {
                return variants;
            }
        }

        hasNextPage = page.pageInfo.hasNextPage;
        cursor = page.pageInfo.endCursor;
    }

    return variants;
}

async function runGraphQL(endpoint, accessToken, query, variables, attempt = 1) {
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'X-Shopify-Access-Token': accessToken,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) {
        throw new Error(`Shopify GraphQL HTTP error ${res.status}: ${await res.text().catch(() => '')}`);
    }

    const body = await res.json();

    if (body.errors) {
        const throttled = body.errors.some((e) => e.extensions?.code === 'THROTTLED');
        if (throttled && attempt <= 5) {
            const delayMs = 1000 * attempt;
            await new Promise((r) => setTimeout(r, delayMs));
            return runGraphQL(endpoint, accessToken, query, variables, attempt + 1);
        }
        throw new Error(`Shopify GraphQL errors: ${JSON.stringify(body.errors)}`);
    }

    const cost = body.extensions?.cost?.throttleStatus;
    if (cost && cost.currentlyAvailable < cost.maximumAvailable * 0.2) {
        const deficit = (cost.maximumAvailable * 0.5) - cost.currentlyAvailable;
        const waitMs = Math.max(0, (deficit / cost.restoreRate) * 1000);
        if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
    }

    return body;
}
