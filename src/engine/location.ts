import type { User, Transaction } from "../types";

/**
 * Location inference from transaction patterns.
 *
 * Problem: No-KYC cards are all registered in Hong Kong, so
 * user.country = "HKG" doesn't mean they're actually in HK.
 * We infer real location from where they actually spend.
 */

export interface InferredLocation {
  primary_country: string;       // Where most spending happens (ISO alpha-3)
  secondary_countries: string[]; // Other countries with significant spend
  confidence: "high" | "medium" | "low";
  evidence: string;              // Human-readable explanation
  spend_by_country: Record<string, { total_usd: number; tx_count: number; pct: number }>;
}

/**
 * Infer the user's actual location from transaction history.
 *
 * Logic:
 * 1. If transactions have explicit location data → aggregate by country
 * 2. If no location data → fall back to profile fields + spending pattern heuristics
 * 3. Country with >50% of spend = primary, >10% = secondary
 */
export function inferLocation(user: User): InferredLocation {
  const txns = user.transaction_history;

  // Case 1: transactions have location data
  const locatedTxns = txns.filter((t) => t.location);
  if (locatedTxns.length > 0) {
    return inferFromLocatedTransactions(locatedTxns, user);
  }

  // Case 2: no location data — use heuristics
  return inferFromHeuristics(user);
}

function inferFromLocatedTransactions(txns: Transaction[], user: User): InferredLocation {
  const byCountry: Record<string, { total_usd: number; tx_count: number }> = {};
  let totalSpend = 0;

  for (const t of txns) {
    const loc = t.location!.toUpperCase();
    if (!byCountry[loc]) byCountry[loc] = { total_usd: 0, tx_count: 0 };
    byCountry[loc].total_usd += t.amount_usd;
    byCountry[loc].tx_count++;
    totalSpend += t.amount_usd;
  }

  const spendByCountry: InferredLocation["spend_by_country"] = {};
  for (const [country, data] of Object.entries(byCountry)) {
    spendByCountry[country] = {
      ...data,
      pct: totalSpend > 0 ? Math.round((data.total_usd / totalSpend) * 100) : 0,
    };
  }

  // Sort by total spend descending
  const sorted = Object.entries(spendByCountry).sort((a, b) => b[1].total_usd - a[1].total_usd);

  const primary = sorted[0]?.[0] || user.current_location || user.country;
  const secondary = sorted
    .slice(1)
    .filter(([_, d]) => d.pct >= 10)
    .map(([c]) => c);

  const confidence = sorted[0]?.[1].pct >= 70 ? "high" : sorted[0]?.[1].pct >= 50 ? "medium" : "low";

  return {
    primary_country: primary,
    secondary_countries: secondary,
    confidence,
    evidence: `Based on ${txns.length} located transactions: ${sorted.map(([c, d]) => `${c} ${d.pct}%`).join(", ")}`,
    spend_by_country: spendByCountry,
  };
}

function inferFromHeuristics(user: User): InferredLocation {
  // self_reported country is the strongest signal
  if (user.self_reported?.country) {
    return {
      primary_country: user.self_reported.country.toUpperCase(),
      secondary_countries: user.country !== user.self_reported.country
        ? [user.country.toUpperCase()]
        : [],
      confidence: "medium",
      evidence: `Self-reported country: ${user.self_reported.country}`,
      spend_by_country: {},
    };
  }

  // If current_location differs from country, current_location is likely more accurate
  // for users who actually have transactions (they're spending somewhere)
  if (user.transaction_history.length > 0 && user.current_location !== user.country) {
    // Spending patterns can hint at location:
    // - High-frequency small transactions (coffee, dining, grocery) = daily life location
    // - Low-frequency large transactions (travel) = travel destinations
    const dailyLifeCategories = new Set([
      "dining", "coffee", "grocery", "convenience_store", "transportation",
      "food_delivery", "pharmacy", "beauty", "spa",
    ]);

    const dailyTxns = user.transaction_history.filter((t) => dailyLifeCategories.has(t.category));
    const dailySpend = dailyTxns.reduce((s, t) => s + t.amount_usd, 0);
    const totalSpend = user.transaction_history.reduce((s, t) => s + t.amount_usd, 0);

    // If heavy daily-life spending exists, current_location is likely real
    if (dailyTxns.length > 10 && dailySpend / totalSpend > 0.5) {
      return {
        primary_country: user.current_location.toUpperCase(),
        secondary_countries: [user.country.toUpperCase()],
        confidence: "medium",
        evidence: `${dailyTxns.length} daily-life transactions (${Math.round(dailySpend / totalSpend * 100)}% of spend) suggest actual location is ${user.current_location}, not registered country ${user.country}`,
        spend_by_country: {},
      };
    }
  }

  // Default: trust current_location over country
  const primary = user.current_location || user.country;
  const secondary = user.current_location && user.current_location !== user.country
    ? [user.country.toUpperCase()]
    : [];

  return {
    primary_country: primary.toUpperCase(),
    secondary_countries: secondary,
    confidence: "low",
    evidence: `No transaction location data; using profile current_location=${user.current_location}, country=${user.country}`,
    spend_by_country: {},
  };
}

/**
 * Get all countries the user is associated with (for constraint checking).
 * Returns the inferred primary + secondary + profile fields, deduplicated.
 */
export function getUserCountries(user: User): string[] {
  const loc = inferLocation(user);
  const all = new Set<string>();
  all.add(loc.primary_country.toUpperCase());
  for (const c of loc.secondary_countries) all.add(c.toUpperCase());
  // Always include profile fields as well
  all.add(user.country.toUpperCase());
  all.add(user.current_location.toUpperCase());
  return [...all];
}
