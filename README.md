# token-radar-01

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/triptrn/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/triptrn/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token launch radar: 226 pre-token protocols from DefiLlama's frozen snapshot (14 Nov 2026), ranked by implied value under the radar-2 model, each with a concrete farm plan. The 40-protocol watchlist (TVL ≥ $50M, no token on record) is covered in full; 186 early pre-token protocols below the floor are ranked alongside it. Live-token protocols are set aside with their market caps shown, never mixed into the ranking.

## The radar-2 model

Implied value follows only from the snapshot's own figures — no protocol name is special-cased:

```
implied = round( tvl_usd x size x growth x maturity x breadth )
size     = 0.30 - 0.05 x clamp(log10(tvl_usd / 1e8), 0, 2)   # 0.30 at $100M, 0.25 at $1B, 0.20 at $10B
growth   = 1 + clamp(change_7d, -40, 150) / 100 x 0.6       # clamped 7-day TVL momentum
maturity = 0.55 + min(age_days, 1825) / 1825 x 0.45         # age with no token on record (unknown: 365d)
breadth  = 1 + 0.04 x min(chains - 1, 5)                    # chains its TVL sits on, capped at six
```

A protocol "records no token" in the snapshot — the snapshot is DefiLlama's record, not proof it has none. Implied value is a model, not a promise and not a price.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input /path/to/snapshot.json
```

`main.ts` (Node 22, standard library only) reads the sealed snapshot, writes `board.json` and `data.js`, copies `dashboard/` and `screenshots/` into the output, and writes `dossier.json` with the vendored make.fun library. The dashboard is a static page with no network: sortable board, search, category and chain filters, a watchlist-only toggle, a live-token view, and a detail view per protocol with its model breakdown and farm plan.

## Files

- `main.ts` — the entrypoint: snapshot in, ranked board and dossier out
- `lib/model.ts` — the radar-2 model, the board builder, the farm plans
- `vendor/makefun-board.ts` — make.fun's dashboard-dossier library (vendored)
- `dashboard/` — the static page: `index.html`, `app.css`, `app.js`
- `screenshots/` — the board, a protocol's detail view, and a filtered view

---

<sub>Entered on [make.fun](https://make.fun/?ref=e32agp4p&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
