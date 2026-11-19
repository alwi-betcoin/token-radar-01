// Token Radar model: one sealed snapshot in, one ranked board out.
//
// The board ranks every protocol the snapshot records no token for (342 of 758) by an implied
// launch value. The value is fitted from the snapshot's own traded comparables: the 128 protocols
// whose token already trades with a recorded market cap and TVL. No protocol name is ever
// special-cased; one function scores every row from the snapshot's figures alone.
//
//   log ratio   = log(mcap / tvl) over the comparables, fitted as
//                 c0 + c1 * (log tvl - mean log tvl) + category offset
//                 (a category's offset is its median residual, shrunk toward 0 by n / (n + 6),
//                 and only fitted for categories with at least 5 comparables)
//   implied     = tvl * exp(log ratio)              (the curve's central estimate)
//               * growth factor   1 + clamp(change_7d, -50, 100) / 100 * 0.30   (null: 1)
//               * maturity factor 0.80 + 0.20 * min(age_days, 1460) / 1460     (unknown age: 730)
//   band        = the central estimate spread by the comparables' residual interquartile range,
//                 so every row also carries the honest range the comparables support.
//
// The model is validated inside this file, on the comparables, two ways, and the numbers ship
// with the board: leave-one-out (refit without each comparable, predict it) and walk-forward
// (fit on comparables listed before 2023, predict the ones listed later). The same numbers for a
// naive flat median ratio are computed alongside, so the reader can see what the structure buys.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The fitted curve and the constants the dashboard states. */
export interface FittedModel {
  comps: number;
  mean_log_tvl: number;
  c0: number;
  c1: number;
  category_offsets: Record<string, number>;
  ratio_log_min: number;
  ratio_log_max: number;
  band_half_log: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
}

/** One board row: the gate's fields plus the figures the dashboard shows. */
export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  watchlist: boolean;
  band_low_usd: number;
  band_high_usd: number;
  base_value_usd: number;
  growth_factor: number;
  maturity_factor: number;
}

/** Out-of-sample honesty numbers, computed from the comparables at build time. */
export interface Validation {
  comps: number;
  loo_median_abs_log_err: number;
  loo_within_2x: number;
  naive_loo_median_abs_log_err: number;
  naive_loo_within_2x: number;
  wf_train: number;
  wf_test: number;
  wf_median_abs_log_err: number;
  wf_within_2x: number;
}

/** Everything the dashboard renders, written to data.js by main.ts. */
export interface RadarPayload {
  as_of: string;
  source: string;
  floor_usd: number;
  model: FittedModel;
  validation: Validation;
  coverage: {
    snapshot_protocols: number;
    tokenized: number;
    comps_fitted: number;
    pre_token: number;
    board_rows: number;
    watchlist: number;
    watchlist_covered: number;
  };
  rows: BoardRow[];
}

export function parseSnapshot(text: string): Snapshot {
  const raw = JSON.parse(text) as Snapshot;
  if (!Array.isArray(raw.protocols) || !Array.isArray(raw.watchlist)) {
    throw new Error('snapshot: protocols and watchlist must be arrays');
  }
  return raw;
}

/** A protocol records a token when DefiLlama carries its gecko id or its symbol. */
export function recordsToken(p: SnapshotProtocol): boolean {
  return p.gecko_id !== null || p.symbol !== null;
}

/** Whole days from listed_at to the snapshot's as_of; null when either is missing. */
export function ageDays(p: SnapshotProtocol, asOf: string): number | null {
  if (p.listed_at === null) return null;
  const a = Date.parse(`${p.listed_at}T00:00:00Z`);
  const b = Date.parse(`${asOf}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

function median(xs: number[]): number {
  const s = [...xs].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function quantile(sorted: number[], q: number): number {
  const at = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return sorted[at]!;
}

/** Fit the ratio curve on a set of comparables (records a token, mcap and TVL both positive). */
export function fitModel(comps: SnapshotProtocol[]): FittedModel {
  const lt = comps.map((p) => Math.log(p.tvl_usd));
  const lr = comps.map((p) => Math.log(p.mcap_usd! / p.tvl_usd));
  const meanLt = lt.reduce((a, b) => a + b, 0) / lt.length;
  const meanLr = lr.reduce((a, b) => a + b, 0) / lr.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < comps.length; i++) {
    num += (lt[i]! - meanLt) * (lr[i]! - meanLr);
    den += (lt[i]! - meanLt) ** 2;
  }
  const c1 = den === 0 ? 0 : num / den;
  const c0 = meanLr;
  const byCategory = new Map<string, number[]>();
  comps.forEach((p, i) => {
    const resid = lr[i]! - (c0 + c1 * (lt[i]! - meanLt));
    const key = p.category ?? '(none)';
    const arr = byCategory.get(key) ?? [];
    arr.push(resid);
    byCategory.set(key, arr);
  });
  const offsets: Record<string, number> = {};
  for (const [cat, resids] of [...byCategory.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (resids.length >= 5) offsets[cat] = (median(resids) * resids.length) / (resids.length + 6);
  }
  const sortedLr = [...lr].sort((a, b) => a - b);
  const residuals = comps.map((p, i) => {
    const offset = offsets[p.category ?? '(none)'] ?? 0;
    return lr[i]! - (c0 + c1 * (lt[i]! - meanLt) + offset);
  });
  const sortedResid = [...residuals].sort((a, b) => a - b);
  const iqr = quantile(sortedResid, 0.75) - quantile(sortedResid, 0.25);
  return {
    comps: comps.length,
    mean_log_tvl: meanLt,
    c0,
    c1,
    category_offsets: offsets,
    ratio_log_min: quantile(sortedLr, 0.02),
    ratio_log_max: quantile(sortedLr, 0.98),
    band_half_log: iqr / 2,
    growth_weight: 0.3,
    growth_floor: -50,
    growth_cap: 100,
    maturity_floor: 0.8,
    maturity_range: 0.2,
    maturity_days: 1460,
    unknown_age_days: 730,
  };
}

/** The curve's fitted log ratio for one protocol, clamped to the comparables' observed range. */
export function fittedLogRatio(model: FittedModel, p: SnapshotProtocol): number {
  const offset = model.category_offsets[p.category ?? '(none)'] ?? 0;
  const raw = model.c0 + model.c1 * (Math.log(Math.max(1, p.tvl_usd)) - model.mean_log_tvl) + offset;
  return Math.min(model.ratio_log_max, Math.max(model.ratio_log_min, raw));
}

/** The growth factor: a hot week lifts the estimate, a cold one trims it, both bounded. */
export function growthFactor(model: FittedModel, change7d: number | null): number {
  if (change7d === null) return 1;
  const clamped = Math.min(model.growth_cap, Math.max(model.growth_floor, change7d));
  return 1 + (clamped / 100) * model.growth_weight;
}

/** The maturity factor: a protocol that has run longer with no token carries more of its value. */
export function maturityFactor(model: FittedModel, age: number | null): number {
  const days = age === null ? model.unknown_age_days : Math.min(Math.max(age, 0), model.maturity_days);
  return model.maturity_floor + (days / model.maturity_days) * model.maturity_range;
}

/** The model's three parts for one protocol, before rounding. */
export function decompose(model: FittedModel, p: SnapshotProtocol, asOf: string): { base: number; growth: number; maturity: number } {
  const base = Math.max(1, p.tvl_usd) * Math.exp(fittedLogRatio(model, p));
  return { base, growth: growthFactor(model, p.change_7d), maturity: maturityFactor(model, ageDays(p, asOf)) };
}

/** Leave-one-out and walk-forward validation of the curve against the naive flat ratio. */
export function validate(comps: SnapshotProtocol[]): Validation {
  const looErr: number[] = [];
  const naiveErr: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const rest = comps.filter((_, j) => j !== i);
    const fit = fitModel(rest);
    const target = comps[i]!;
    looErr.push(Math.abs(Math.log(target.mcap_usd! / (target.tvl_usd * Math.exp(fittedLogRatio(fit, target))))));
    const flat = median(rest.map((p) => Math.log(p.mcap_usd! / p.tvl_usd)));
    naiveErr.push(Math.abs(Math.log(target.mcap_usd! / (target.tvl_usd * Math.exp(flat)))));
  }
  const train = comps.filter((p) => p.listed_at !== null && p.listed_at < '2023-01-01');
  const test = comps.filter((p) => p.listed_at !== null && p.listed_at >= '2023-01-01');
  const wfFit = fitModel(train);
  const wfErr = test.map((p) => Math.abs(Math.log(p.mcap_usd! / (p.tvl_usd * Math.exp(fittedLogRatio(wfFit, p))))));
  const within = (errs: number[]) => errs.filter((e) => e < Math.log(2)).length / errs.length;
  return {
    comps: comps.length,
    loo_median_abs_log_err: median(looErr),
    loo_within_2x: within(looErr),
    naive_loo_median_abs_log_err: median(naiveErr),
    naive_loo_within_2x: within(naiveErr),
    wf_train: train.length,
    wf_test: test.length,
    wf_median_abs_log_err: median(wfErr),
    wf_within_2x: within(wfErr),
  };
}

/** A stable small hash of a slug, so plan wording varies by protocol but never between runs. */
export function slugHash(slug: string): number {
  let h = 2166136261;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/** Rough per-action cost in dollars by the chain a step runs on; stated on the page as an estimate. */
const CHAIN_ACTION_COST: Record<string, number> = {
  Ethereum: 8, Solana: 0.05, Bitcoin: 1.5, Binance: 0.2, Arbitrum: 0.15, Base: 0.1,
  Optimism: 0.15, Polygon: 0.05, Avalanche: 0.25, Tron: 0.3, Sui: 0.05, Aptos: 0.05,
};
function actionCost(chain: string): string {
  const c = CHAIN_ACTION_COST[chain];
  if (c === undefined) return 'about $0.50';
  return c < 1 ? `about $${c.toFixed(2)}` : `about $${c.toFixed(0)}`;
}

/** What a farmer actually does in each category: [first use, deepening move]. */
const CATEGORY_MOVES: Record<string, [string, string]> = {
  Dexs: ['Swap through the main pools in both directions', 'Provide liquidity to a flagship pair inside a tight range'],
  Lending: ['Supply a blue-chip asset (ETH, a major stablecoin) as collateral', 'Take a small, well-collateralised borrow and repay it on schedule'],
  'Liquid Staking': ['Stake the chain\'s native asset through the protocol', 'Hold the liquid receipt token in the same wallet and use it in one integrated market'],
  'Liquid Restaking': ['Restake a liquid staking token into the protocol', 'Keep the position through a full rewards epoch without withdrawing'],
  Bridge: ['Bridge a native asset across two of its busiest corridors', 'Bridge back on a different corridor so both directions count'],
  'Canonical Bridge': ['Bridge the chain\'s canonical asset in from Ethereum', 'Bridge a second asset class (a stablecoin) over the same route'],
  Yield: ['Deposit into the flagship vault that matches your risk level', 'Compound the yield back into the same vault weekly'],
  CEX: ['Complete KYC and make a first spot trade', 'Join the exchange\'s earn or launchpool product with a standing balance'],
  'Risk Curators': ['Allocate to one curated vault whose strategy you can explain', 'Follow the curator\'s rebalances and keep the position for a full quarter'],
  'Onchain Capital Allocator': ['Deposit into an allocator vault on its main chain', 'Stay allocated through two reporting cycles without redeeming'],
  RWA: ['Complete the onboarding or KYC its real-world products require', 'Hold a tokenised treasury or credit position through a full yield cycle'],
  CDP: ['Open a small vault with a blue-chip collateral asset', 'Mint a modest amount of its stablecoin and keep the vault safely collateralised'],
  'Basis Trading': ['Deposit stablecoins into the basis vault', 'Leave the position untouched through a full funding cycle'],
  'Uncollateralized Lending': ['Lend to one pool whose borrowers are named', 'Renew the loan at maturity instead of withdrawing early'],
  Payments: ['Route one real payment through the protocol', 'Keep a working balance and repeat the payment monthly'],
};

/** Build one protocol's farm plan: five concrete steps, each with a cost and a duration. */
export function farmPlan(p: SnapshotProtocol, asOf: string): string[] {
  const chain = p.chains[0] ?? 'Ethereum';
  const moves = CATEGORY_MOVES[p.category ?? ''] ?? [
    `Use ${p.name}'s core product on ${chain} with a real position`,
    'Repeat the core action weekly so the activity history is continuous',
  ];
  const tier = p.tvl_usd >= 1_000_000_000 ? '$1,000-$5,000' : p.tvl_usd >= 100_000_000 ? '$500-$2,000' : '$250-$1,000';
  const cost = actionCost(chain);
  const variant = slugHash(p.slug) % 2;
  const cadence = variant === 0 ? 'once a week for 8-12 weeks' : 'twice a month for a full quarter';
  // An exchange is farmed on the exchange itself; its first listed chain would name the wrong venue.
  const isExchange = p.category === 'CEX';
  const venue = isExchange ? 'the exchange itself' : chain;
  const feeWhere = isExchange ? 'in trading fees' : `in fees on ${chain}`;
  return [
    `Start on ${venue}: ${moves[0].charAt(0).toLowerCase()}${moves[0].slice(1)} with a position of ${tier}; the action itself costs ${cost} ${feeWhere}. Give this first step one focused session of about 30 minutes.`,
    `Keep a cadence: repeat the core action ${cadence}, varying size modestly each time. Budget ${cost} per action ${feeWhere}; a quarter of steady activity costs roughly ${variant === 0 ? '$40-$120' : '$25-$90'} all-in at these fee levels.`,
    `Deepen the position: ${moves[1].charAt(0).toLowerCase()}${moves[1].slice(1)}. This is the step most casual farmers skip; hold it for at least 6 weeks so snapshots and season ends see a real balance, not a pass-through.`,
    `Track eligibility as you go: keep the same wallet for every step, screenshot balances at each month end, and spend about 15 minutes a week checking ${p.name}'s official channels for points, seasons or a testnet-to-mainnet migration that changes the plan.`,
    `Re-check the token record before adding size: the snapshot of ${asOf} records no token for ${p.name}; if a token or an official announcement appears, stop farming and review the position instead of adding to it.`,
  ];
}

/** Build the whole radar: fit, validate, rank every pre-token protocol, plan every farm. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarPayload } {
  const comps = snapshot.protocols.filter((p) => recordsToken(p) && (p.mcap_usd ?? 0) > 0 && p.tvl_usd > 0);
  const model = fitModel(comps);
  const validation = validate(comps);
  const watch = new Set(snapshot.watchlist);
  const preToken = snapshot.protocols.filter((p) => !recordsToken(p));
  const rows: BoardRow[] = preToken.map((p) => {
    const { base, growth, maturity } = decompose(model, p, snapshot.as_of);
    const implied = Math.max(1, Math.round(base * growth * maturity));
    const spread = Math.exp(model.band_half_log);
    return {
      slug: p.slug,
      name: p.name,
      rank: 0,
      implied_value_usd: implied,
      farm_steps: farmPlan(p, snapshot.as_of),
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      age_days: ageDays(p, snapshot.as_of),
      watchlist: watch.has(p.slug),
      band_low_usd: Math.max(1, Math.round(implied / spread)),
      band_high_usd: Math.round(implied * spread),
      base_value_usd: Math.round(base),
      growth_factor: Math.round(growth * 1000) / 1000,
      maturity_factor: Math.round(maturity * 1000) / 1000,
    };
  });
  rows.sort((a, b) => b.implied_value_usd - a.implied_value_usd || a.slug.localeCompare(b.slug));
  rows.forEach((r, i) => { r.rank = i + 1; });
  const radar: RadarPayload = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    validation,
    coverage: {
      snapshot_protocols: snapshot.protocols.length,
      tokenized: snapshot.protocols.filter(recordsToken).length,
      comps_fitted: comps.length,
      pre_token: preToken.length,
      board_rows: rows.length,
      watchlist: snapshot.watchlist.length,
      watchlist_covered: snapshot.watchlist.filter((s) => rows.some((r) => r.slug === s)).length,
    },
    rows,
  };
  return { board: rows, radar };
}

/** The first reason the gate would refuse this board, or null when it passes our own checks. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `board holds ${board.length} rows, outside 100-4000`;
  const slugs = new Set(board.map((r) => r.slug));
  if (slugs.size !== board.length) return 'a slug appears twice';
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  for (const r of board) if (!known.has(r.slug)) return `invented slug ${r.slug}`;
  for (const w of snapshot.watchlist) if (!slugs.has(w)) return `watchlist slug ${w} is missing`;
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 0; i < byRank.length; i++) {
    if (byRank[i]!.rank !== i + 1) return 'ranks are not exactly 1..N';
    if (i > 0 && byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) return 'implied value rises as rank ascends';
    const steps = byRank[i]!.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `row ${byRank[i]!.slug} holds ${steps.length} farm steps`;
    for (const s of steps) {
      const len = s.trim().length;
      if (len < 20 || len > 600) return `a farm step of row ${byRank[i]!.slug} is ${len} characters`;
    }
  }
  if (new Set(board.map((r) => r.implied_value_usd)).size < 2) return 'every implied value is the same';
  return null;
}

/** The dashboard's data file: the same figures the board carries, as one script. */
export function dataScript(radar: RadarPayload): string {
  return `window.RADAR = ${JSON.stringify(radar)};\n`;
}
