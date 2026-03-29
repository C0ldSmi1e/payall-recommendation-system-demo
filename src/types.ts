export interface Transaction {
  card_id: number;
  amount_usd: number;
  category: string;
  date: string;
  location?: string; // ISO alpha-3 country code, inferred from merchant
}

export interface User {
  id: string;
  name: string;
  description: string;
  country: string;
  current_location: string;
  kyc_verified: boolean;
  monthly_spend_usd: number;
  primary_use: string[];
  preferred_currency: string;
  held_cryptos: string[];
  preferred_topup_crypto: string;
  wants_physical_card: boolean;
  wants_virtual_card: boolean;
  fee_sensitivity: "low" | "medium" | "high";
  needs_apple_pay: boolean;
  needs_google_pay: boolean;
  needs_wechat_pay: boolean;
  needs_alipay: boolean;
  priorities: string[];
  owned_card_ids: number[];
  transaction_history: Transaction[];
  self_reported?: {
    needs_description?: string;
    country?: string;
    device_type?: "iphone" | "android" | "both";
    preferred_assets?: string[];
  };
}

export interface Card {
  id: number;
  card_name: string;
  vendor: string;
  card_type: string;
  is_credit: number;
  has_physical_card: number;
  has_virtual_card: number;
  kyc_required: number;
  based_currency: string;
  based_crypto: string;
  cashback: string;
  cashback_max: string;
  fees: string;
  spending_limits: string;
  atm_withdrawal_support: number;
  google_pay_support: number;
  apple_wallet_support: number;
  wechat_pay_support: number;
  alipay_support: number;
  chatgpt_pay_support: number;
  disallowed_countries: string;
  limits: string;
  key_features: string;
  summary: string;
  intro: string;
  application_url: string;
  can_apply: number;
  tags: string | null;
  is_deleted: number;
  card_image_large: string;
  vendor_logo: string | null;
  card_image_thumbnail: string;
  general_ratings: number;
  benefit_ratings: number;
  privacy_ratings: number;
}

// ---- CoT Pipeline Types ----

export interface StepMeta {
  id: string;
  name: string;
  description: string;
}

// Step 1 output: User State Analysis
export interface UserState {
  summary: string;
  hard_requirements: {
    country: string;
    current_location: string;
    kyc_status: "verified" | "unverified";
    needs_physical: boolean;
    needs_virtual: boolean;
    payment_methods: string[];
  };
  spending_profile: {
    monthly_usd: number;
    top_categories: string[];
    spending_pattern: string;
  };
  preferences: {
    fee_sensitivity: string;
    priorities_ranked: string[];
    crypto_preferences: string[];
    preferred_topup: string;
    preferred_currency: string;
  };
  deal_breakers: string[];
  nice_to_haves: string[];
  owned_card_context: string;
  derived_scores: {
    kyc_friction_tolerance: number;
    travel_need_score: number;
    fee_sensitivity_score: number;
    instant_need_score: number;
    backup_card_need: number;
    spending_diversity: number;
  };
  journey_position: "new_user" | "active_single_card" | "multi_card_user" | "heavy_spender";
  current_mode: "travel" | "routine" | "exploring" | "urgent";
  detected_intent: string;
}

// Step 2 output: Constraint Engine
export interface FeasibleSet {
  feasible: {
    card_id: number;
    card_name: string;
    kyc_gate: boolean;
    note: string;
  }[];
  eliminated: {
    card_id: number;
    card_name: string;
    reason: string;
    blocked_reason_category: "country" | "deleted" | "owned" | "status";
  }[];
}

// Step 3 output: User Preference Analysis (CoT-Rec Step A)
export interface PreferenceProfile {
  right_now_priorities: { factor: string; weight: number }[];
  short_term_intent: string;
  long_term_intent: string;
  friction_budget: "low" | "medium" | "high";
  value_vs_convenience: "value" | "balanced" | "convenience";
  spending_insights: string[];
  unmet_needs: string[];
}

// Step 4 output: Card Perception Analysis (CoT-Rec Step B)
export interface MultiOutcomeCard {
  card_id: number;
  card_name: string;
  outcomes: {
    p_activation_success: number;
    e_monthly_savings: number;
    feature_coverage: number;
    friction_score: number;
    risk_score: number;
    complementarity: number;
  };
  composite_score: number;
  key_insight: string;
}

export interface PerceptionResult {
  cards: MultiOutcomeCard[];
}

// Step 5 output: Reasoning & Ranking
export interface RankedCard {
  card_id: number;
  card_name: string;
  final_score: number;
  role: "primary" | "backup" | "contender";
  vs_primary: string;
  key_tradeoff: string;
}

export interface RankingResult {
  ranked: RankedCard[];
  head_to_head_summary: string;
}

// Personalization insight — "we know you" moments
export interface PersonalizationInsight {
  type: "location_inference" | "spending_pattern" | "gap_analysis" | "savings_opportunity" | "pain_point";
  title: string;
  description: string;
  evidence: string;
  impact: "high" | "medium" | "low";
}

// Score breakdown — transparent reasoning per dimension
export interface ScoreBreakdown {
  dimension: string;           // e.g. "activation", "savings", "features"
  label: string;               // e.g. "Ease of Getting Started"
  score: number;               // 0-100
  explanation: string;         // Why this score, referencing user's actual data
}

// User's relationship with Bit2Go (our revenue card)
export type Bit2GoStatus = "no_card" | "has_card_low_usage" | "has_card_active";

// Revenue action — what we want the user to do
export interface RevenueAction {
  type: "open_card" | "topup" | "cashout" | "increase_usage";
  headline: string;          // "Open Your Bit2Go Card" or "Top Up Your Bit2Go"
  description: string;       // Personalized reason tied to their spending
  value_proposition: string; // Concrete benefit: "Start earning 1% cashback on your $8K/mo spend"
  urgency: string;           // "Every day without this card costs you $X"
  cta_text: string;          // Button text: "Open Card Now" or "Top Up $500"
}

// Step 6 output: Final Recommendation & Action Plan
export interface FinalRecommendation {
  // User understanding
  insights: PersonalizationInsight[];
  inferred_location: {
    city_or_region: string;    // "Silicon Valley" not just "USA"
    country_code: string;
    registered_country: string;
    mismatch: boolean;
    explanation: string;
  };

  // Bit2Go-specific revenue action (always present)
  bit2go_action: RevenueAction;

  // Primary card recommendation (may or may not be Bit2Go)
  primary: {
    card_id: number;
    card_name: string;
    score: number;
    tagline: string;
    reason: string;
    pros: string[];
    cons: string[];
    score_breakdown: ScoreBreakdown[];
    savings_vs_current: {
      monthly_usd: number;
      annual_usd: number;
      breakdown: string;
    };
    conversion_hook: string;
    next_action: { type: string; description: string };
  };
  backups: {
    card_id: number;
    card_name: string;
    score: number;
    tagline: string;
    reason: string;
    pick_this_if: string;
    key_advantage: string;
  }[];
  why_not_others: { card_name: string; reason: string }[];
}

// SSE send function type
export type SendFn = (event: string, data: unknown) => void;

// ---- Feedback Layer ----

export interface CardFeedback {
  user_id: string;
  card_id: number;
  action: "like" | "dislike";
  timestamp: number;
}

export interface CardOpeningResult {
  user_id: string;
  card_id: number;
  card_name: string;
  kyc_success: boolean;
  topup_success: boolean;
  approval: boolean;
  timestamp: number;
}

export interface FeedbackStore {
  card_feedbacks: CardFeedback[];
  opening_results: CardOpeningResult[];
}
