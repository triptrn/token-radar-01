// Token radar, model radar-2, retold from the spec.
//
// A frozen DefiLlama snapshot goes in; a ranked board comes out. The board
// always covers the snapshot's whole watchlist — the forty protocols at or
// above the $50M floor that record no token — and then adds the early radar:
// pre-token protocols below the floor, taken by TVL, that the radar exists to
// surface. Anything that already trades is set aside with its market cap and
// never enters the ranking.
//
// A protocol "records no token" when the snapshot carries no market cap, no
// CoinGecko id and no symbol for it. That is the snapshot's record, not a
// proof that no token exists anywhere.
//
// Implied value is a product of four factors, each read off the snapshot:
//
//   size     0.30 at or below $100M of TVL, losing 0.05 per decade of TVL
//            above it, down to 0.20. Big protocols are worth fewer dollars
//            per TVL dollar.
//   growth   the 7-day TVL change, clamped to [-40%, +150%], then
//            1 + pct/100 * 0.6. One hot week can at most roughly double a
//            value, one bad week can cut it by about a quarter.
//   maturity 0.55 plus up to 0.45 for age with no token on record, reaching
//            the full weight at five years. Age is days since first listing;
//            an unknown listing date counts as one year.
//   breadth  1.00 plus 0.04 per extra chain, capped at six chains.
//
//   implied = max(1, round(tvl * size * growth * maturity * breadth))
//
// No name is ever special-cased: one function scores every row.

/** One protocol entry, exactly the ten fields the sealed input carries. */
export interface Entry {
  slug: string; name: string;
  category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null;
  mcap_usd: number | null; listed_at: string | null;
  gecko_id: string | null; symbol: string | null;
}

/** The whole snapshot document. */
export interface SnapshotDoc {
  as_of: string; source: string; floor_usd: number;
  protocols: Entry[]; watchlist: string[];
}

/** The model's constants, as the dashboard states them. */
export interface Tuning {
  size_high: number; size_step: number; size_ref_tvl: number; size_log_cap: number;
  growth_weight: number; growth_floor: number; growth_cap: number;
  maturity_floor: number; maturity_range: number; maturity_days: number; unknown_age_days: number;
  breadth_per_chain: number; breadth_max_extra: number;
}

export const MODEL: Tuning = {
  size_high: 0.3, size_step: 0.05, size_ref_tvl: 100_000_000, size_log_cap: 2,
  growth_weight: 0.6, growth_floor: -40, growth_cap: 150,
  maturity_floor: 0.55, maturity_range: 0.45, maturity_days: 1825, unknown_age_days: 365,
  breadth_per_chain: 0.04, breadth_max_extra: 5,
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION: string = 'radar-2';

/** How many pre-token protocols below the watchlist floor the early radar carries, by TVL. */
export const EARLY_LIMIT: number = 200;

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_LIMIT: number = 24;

/** One farm step: the action, what it costs, and how long it takes. */
export interface Step {
  text: string; cost: string; time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardEntry {
  rank: number; slug: string; name: string;
  category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null;
  mcap_usd: number | null; listed_at: string | null;
  gecko_id: string | null; symbol: string | null;
  token_status: 'pre-token'; age_days: number | null;
  implied_value_usd: number;
  model: {
    size_multiplier: number; growth_pct: number; growth_multiplier: number;
    maturity_multiplier: number; breadth_multiplier: number; age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row, with farm plans generated in the page. */
export interface LiteEntry {
  rank: number; slug: string; name: string;
  category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null;
  mcap_usd: number | null; listed_at: string | null;
  age_days: number | null; implied_value_usd: number;
  size_multiplier: number; growth_multiplier: number;
  maturity_multiplier: number; breadth_multiplier: number;
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveEntry {
  slug: string; name: string; category: string | null;
  chains: string[]; tvl_usd: number;
  mcap_usd: number | null; change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface BoardPayload {
  as_of: string; source: string; floor_usd: number;
  model: Tuning; model_version: string;
  watchlist_size: number; board_size: number;
  early_size: number; live_size: number;
  rows: LiteEntry[]; live: LiveEntry[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotError";
  }
}

/** The four multipliers and the implied value one protocol gets, plus its age. */
export interface Score {
  value: number; size: number; growthPct: number;
  growth: number; maturity: number; breadth: number;
  age: number | null;
}

const DAY_MS: number = 86_400_000;

/** `x` held inside [lo, hi]. */
function clamp(x: number, lo: number, hi: number): number {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

/** A finite number, else `fallback`. */
function finiteOr(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return value;
}

/** Round to four decimals, for the multipliers the board carries. */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Whole days from `listedAt` to `asOf`, never below zero; null when either date is absent or bad. */
export function daysBetween(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const start = Date.parse(asOf + 'T00:00:00Z');
  const end = Date.parse(listedAt + 'T00:00:00Z');
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const span = Math.floor((start - end) / DAY_MS);
  return span < 0 ? 0 : span;
}

/** The value-per-TVL multiple: 0.30 at or below $100M of TVL, falling 0.05 per decade to 0.20. */
function sizeFactor(tvl: number, t: Tuning): number {
  const decades = clamp(Math.log10(Math.max(tvl, 1) / t.size_ref_tvl), 0, t.size_log_cap);
  return t.size_high - t.size_step * decades;
}

/** The chain-breadth multiplier: 1.00 on one chain, +0.04 per extra chain, capped at six chains. */
function breadthFactor(chainCount: number, t: Tuning): number {
  return 1 + t.breadth_per_chain * clamp(chainCount - 1, 0, t.breadth_max_extra);
}

/** The four multipliers and the implied value one protocol gets under `t`. */
export function scoreEntry(p: Entry, asOf: string, t: Tuning): Score {
  const age = daysBetween(asOf, p.listed_at);
  const growthPct = clamp(finiteOr(p.change_7d, 0), t.growth_floor, t.growth_cap);
  const growth = 1 + (growthPct / 100) * t.growth_weight;
  const aged = age === null ? t.unknown_age_days : age;
  const maturity = t.maturity_floor + (clamp(aged, 0, t.maturity_days) / t.maturity_days) * t.maturity_range;
  const size = sizeFactor(p.tvl_usd, t);
  const breadth = breadthFactor(p.chains.length, t);
  const value = Math.max(1, Math.round(p.tvl_usd * size * growth * maturity * breadth));
  return { value, size, growthPct, growth, maturity, breadth, age };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSION_TAIL: RegExp = /\s([Vv]\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol records no token at all. */
export function hasNoToken(p: Entry): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank: pre-token, not an exchange, not a versioned pool. */
export function canRank(p: Entry): boolean {
  if (!hasNoToken(p)) return false;
  if (p.category === 'CEX') return false;
  return !VERSION_TAIL.test(p.name);
}

/** The snapshot's protocols by slug. */
function bySlug(entries: Entry[]): Map<string, Entry> {
  const out = new Map<string, Entry>();
  for (const e of entries) out.set(e.slug, e);
  return out;
}

/** The early radar's picks: pre-token protocols below the watchlist floor, by TVL, capped. */
function earlyPicks(doc: SnapshotDoc, taken: Set<string>): Entry[] {
  const pool: Entry[] = [];
  for (const p of doc.protocols) {
    if (taken.has(p.slug)) continue;
    if (!canRank(p)) continue;
    if (p.tvl_usd >= doc.floor_usd) continue;
    pool.push(p);
  }
  pool.sort((a, b) => {
    if (b.tvl_usd !== a.tvl_usd) return b.tvl_usd - a.tvl_usd;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  return pool.slice(0, EARLY_LIMIT);
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(doc: SnapshotDoc, t: Tuning = MODEL): BoardEntry[] {
  const index = bySlug(doc.protocols);
  const taken = new Set<string>();
  for (const slug of doc.watchlist) {
    if (index.has(slug)) taken.add(slug);
  }
  const chosen: Entry[] = [];
  for (const slug of taken) chosen.push(index.get(slug) as Entry);
  for (const p of earlyPicks(doc, taken)) chosen.push(p);

  const scored = chosen.map((p) => ({ entry: p, score: scoreEntry(p, doc.as_of, t) }));
  scored.sort((a, b) => {
    if (b.score.value !== a.score.value) return b.score.value - a.score.value;
    return a.entry.slug < b.entry.slug ? -1 : a.entry.slug > b.entry.slug ? 1 : 0;
  });
  return scored.map((s, i) => {
    const p = s.entry;
    const v = s.score;
    return {
      rank: i + 1, slug: p.slug, name: p.name,
      category: p.category, chains: p.chains,
      tvl_usd: p.tvl_usd, change_7d: p.change_7d,
      mcap_usd: p.mcap_usd, listed_at: p.listed_at,
      gecko_id: p.gecko_id, symbol: p.symbol,
      token_status: 'pre-token', age_days: v.age,
      implied_value_usd: v.value,
      model: {
        size_multiplier: round4(v.size), growth_pct: v.growthPct, growth_multiplier: round4(v.growth),
        maturity_multiplier: round4(v.maturity), breadth_multiplier: round4(v.breadth), age_days: v.age,
      },
      farm_steps: planFor(p, v.age).map(stepString),
    };
  });
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepString(step: Step): string {
  let out = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
  if (out.length > 600) out = out.slice(0, 596) + '...';
  if (out.length < 20) out = out + ' Hold the position and check the protocol\'s own page.';
  return out;
}

/** The first chain a protocol names, or a neutral phrase. */
function firstChainName(p: Entry): string {
  return p.chains.length > 0 ? (p.chains[0] as string) : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: Entry): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDays(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** One category template: the category words it matches and the action it gives. */
interface ActionTemplate {
  keys: string[];
  build: (capital: number, name: string, chain: string) => string;
}

/** The category's one action, in the words a farmer can follow. First matching template wins. */
const ACTION_TABLE: ActionTemplate[] = [
  {
    keys: ['lend', 'cdp', 'collateral'],
    build: (capital, name, chain) => 'Supply $' + capital + ' of USDC to ' + name + ' on ' + chain + ' and keep the position open.',
  },
  {
    keys: ['dex', 'yield', 'leveraged farm'],
    build: (capital, name, chain) => 'Provide $' + capital + " of liquidity to " + name + "'s main pool on " + chain + ' and keep the position open.',
  },
  {
    keys: ['bridge'],
    build: (capital, name, chain) => 'Bridge $' + capital + ' of USDC to ' + chain + ' through ' + name + ' and use the bridged funds in its app.',
  },
  {
    keys: ['staking', 'restak'],
    build: (capital, name, chain) => "Stake $" + capital + " of the chain's staking asset through " + name + ' and keep the receipt.',
  },
  {
    keys: ['perpetual', 'derivative'],
    build: (capital, name, chain) => 'Deposit $' + capital + ' of USDC as margin on ' + name + ' and open one small hedge.',
  },
  {
    keys: ['prediction'],
    build: (capital, name) => 'Fund $' + capital + ' and place one market position on ' + name + '.',
  },
  {
    keys: ['curator', 'allocator'],
    build: (capital, name, chain) => 'Deposit $' + capital + ' into a ' + name + ' vault on ' + chain + ' and keep the shares.',
  },
  {
    keys: ['stable'],
    build: (capital, name, chain) => 'Mint or deposit $' + capital + ' of the stable asset through ' + name + ' on ' + chain + '.',
  },
  {
    keys: ['rwa'],
    build: (capital, name, chain) => 'Mint $' + capital + " of the protocol's yield asset on " + chain + ' and hold it.',
  },
  {
    keys: ['insurance'],
    build: (capital, name, chain) => 'Buy $' + capital + ' of cover from ' + name + ' on ' + chain + ' and keep the policy.',
  },
];

function actionFor(p: Entry, capital: number, chain: string): string {
  const c = (p.category === null ? '' : p.category).toLowerCase();
  for (const template of ACTION_TABLE) {
    for (const key of template.keys) {
      if (c.indexOf(key) !== -1) return template.build(capital, p.name, chain);
    }
  }
  return 'Deposit $' + capital + ' of USDC into ' + p.name + ' on ' + chain + ' and keep the position open.';
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time. The plan is derived from
 * the protocol's own record (category, chains, TVL, age), never from a hand-written list of names.
 */
export function planFor(p: Entry, age: number | null): Step[] {
  const chain = firstChainName(p);
  const capital = capitalFor(p);
  const hold = holdDays(age);
  const gas = capital >= 150 ? 8 : 4;
  return [
    {
      text: 'Use a fresh wallet that holds only the funds you plan to farm, ' + 'and keep its seed phrase offline.',
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: actionFor(p, capital, chain),
      cost: '$' + capital + ' of capital and about $' + gas + ' of gas',
      time: '15 minutes to set up',
    },
    {
      text: 'Make one qualifying action each week, such as a deposit, ' + 'a borrow, a swap or a vote.',
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: 'Hold the position for at least ' + hold + ' days so the activity is counted in more than one snapshot.',
      cost: 'the $' + capital + ' stays in the position',
      time: hold + ' days',
    },
    {
      text: "Before you withdraw, open the protocol's own points or rewards page " + 'and claim only from the link it publishes.',
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: 'Write the wallet, the dates and every transaction in a farm log ' + 'so you can repeat the position or unwind it.',
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** Market cap first, TVL as the tiebreak: the live view is the market's own ranking. */
function byMarketCap(a: Entry, b: Entry): number {
  const capA = a.mcap_usd === null ? 0 : a.mcap_usd;
  const capB = b.mcap_usd === null ? 0 : b.mcap_usd;
  if (capB !== capA) return capB - capA;
  return b.tvl_usd - a.tvl_usd;
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveEntries(doc: SnapshotDoc): LiveEntry[] {
  const trading: Entry[] = [];
  for (const p of doc.protocols) {
    if (hasNoToken(p)) continue;
    if (p.category === 'CEX') continue;
    trading.push(p);
  }
  trading.sort(byMarketCap);
  return trading.slice(0, LIVE_LIMIT).map((p) => ({
    slug: p.slug, name: p.name, category: p.category,
    chains: p.chains, tvl_usd: p.tvl_usd,
    mcap_usd: p.mcap_usd, change_7d: p.change_7d,
  }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function liteEntry(row: BoardEntry): LiteEntry {
  return {
    rank: row.rank, slug: row.slug, name: row.name,
    category: row.category, chains: row.chains,
    tvl_usd: row.tvl_usd, change_7d: row.change_7d,
    mcap_usd: row.mcap_usd, listed_at: row.listed_at,
    age_days: row.age_days, implied_value_usd: row.implied_value_usd,
    size_multiplier: row.model.size_multiplier, growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier, breadth_multiplier: row.model.breadth_multiplier,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(doc: SnapshotDoc, t: Tuning = MODEL): { board: BoardEntry[]; radar: BoardPayload } {
  const board = buildBoard(doc, t);
  const live = liveEntries(doc);
  let early = 0;
  for (const r of board) {
    if (doc.watchlist.indexOf(r.slug) === -1) early += 1;
  }
  const radar: BoardPayload = {
    as_of: doc.as_of, source: doc.source, floor_usd: doc.floor_usd,
    model: t, model_version: MODEL_VERSION,
    watchlist_size: doc.watchlist.length, board_size: board.length,
    early_size: early, live_size: live.length,
    rows: board.map(liteEntry), live,
  };
  return { board, radar };
}

/** A finite number from the raw JSON, else null. */
function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** A string from the raw JSON, else null. */
function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** One protocol entry out of the raw snapshot JSON, refused unless it carries what the model needs. */
function readEntry(v: unknown, i: number): Entry {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new SnapshotError("snapshot.json's protocol " + i + ' is not an object');
  }
  const p = v as Record<string, unknown>;
  if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
    throw new SnapshotError("snapshot.json's protocol " + i + ' lacks a slug, a name or a TVL');
  }
  const chains: string[] = [];
  if (Array.isArray(p.chains)) {
    for (const c of p.chains) {
      if (typeof c === 'string') chains.push(c);
    }
  }
  return {
    slug: p.slug, name: p.name,
    category: strOrNull(p.category), chains,
    tvl_usd: p.tvl_usd,
    change_7d: numOrNull(p.change_7d), mcap_usd: numOrNull(p.mcap_usd),
    listed_at: strOrNull(p.listed_at),
    gecko_id: strOrNull(p.gecko_id), symbol: strOrNull(p.symbol),
  };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): SnapshotDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  const need = (ok: boolean, msg: string): void => {
    if (!ok) throw new SnapshotError(msg);
  };
  need(typeof o.as_of === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.as_of), 'snapshot.json has no as_of date');
  need(typeof o.source === 'string', 'snapshot.json has no source');
  need(typeof o.floor_usd === 'number' && Number.isSafeInteger(o.floor_usd) && o.floor_usd > 0, 'snapshot.json has no floor_usd');
  need(Array.isArray(o.protocols), 'snapshot.json has no protocols array');
  need(Array.isArray(o.watchlist) && o.watchlist.every((s) => typeof s === 'string'), 'snapshot.json has no watchlist of slugs');
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols: o.protocols.map((v, i) => readEntry(v, i)),
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardEntry[], doc: SnapshotDoc): string | null {
  const seen = new Set(board.map((r) => r.slug));
  const missing = doc.watchlist.filter((s) => !seen.has(s));
  if (missing.length > 0) {
    return 'the board misses ' + missing.length + ' watchlist slug' + (missing.length === 1 ? '' : 's') + ': ' + missing.slice(0, 5).join(', ');
  }
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  const badRank = ranks.findIndex((rank, i) => rank !== i + 1);
  if (badRank !== -1) return 'rank ' + (badRank + 1) + ' is ' + ranks[badRank];
  const outOfOrder = board.findIndex((r, i) => i > 0 && r.implied_value_usd > board[i - 1]!.implied_value_usd);
  if (outOfOrder !== -1) {
    return 'row ' + (outOfOrder + 1) + ' outranks row ' + outOfOrder + ' on implied value';
  }
  const first = board[0];
  const last = board[board.length - 1];
  if (board.length >= 2 && first !== undefined && last !== undefined && first.implied_value_usd === last.implied_value_usd) {
    return 'all ' + board.length + ' rows share the same implied value $' + first.implied_value_usd + ': a board that ranks nothing by value is not a ranking';
  }
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return r.slug + ' has ' + r.farm_steps.length + ' farm steps';
    const badStep = r.farm_steps.find((s) => s.length < 20 || s.length > 600);
    if (badStep !== undefined) return r.slug + ' has a farm step of ' + badStep.length + ' characters';
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return r.slug + ' has implied value ' + r.implied_value_usd;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: BoardPayload): string {
  return 'window.RADAR=' + JSON.stringify(radar) + ';\n';
}
