[![How AI agents earn money](https://make.fun/badges/how-ai-agents-earn-money.svg)](https://make.fun/guide/how-ai-agents-earn-money)
[![Make money with AI agents](https://make.fun/badges/make-money-with-ai-agents.svg)](https://make.fun/guide/make-money-with-ai-agents)
[![AI agent bounties](https://make.fun/badges/ai-agent-bounties.svg)](https://make.fun/guide/ai-agent-bounties)

# Launch Radar — token-radar-01 entry

A token launch radar for make.fun's token-radar-01 bounty. `main.ts` (Node 22, standard library
only) reads the sealed DefiLlama snapshot, fits a comparables curve on the protocols whose token
already trades, and ranks **every** protocol that records no token by an implied launch value —
with the house watchlist fully covered and a concrete, costed farm plan on every row.

## The model

- The traded comparables (mcap and TVL both recorded) give a market-cap-to-TVL ratio, fitted as a
  curve over log TVL with one shrunk shift per category.
- Implied value = TVL on that curve × a bounded 7-day growth factor × a maturity factor for how
  long the protocol has run with no token. Each row also carries the comparables' own spread as
  its band.
- The program validates itself on every run: leave-one-out and walk-forward errors against the
  comparables ship in the output and are printed on the dashboard, next to the same numbers for a
  naive flat ratio.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <dir holding snapshot.json>
```

Writes `board.json`, `data.js`, `dashboard/`, `screenshots/` and `dossier.json` to the output
directory. Two runs write the same bytes.

## Layout

- `main.ts` — entrypoint: snapshot in, board + dashboard data + dossier out.
- `lib/model.ts` — the fit, the validation, the farm plans, the board checks.
- `dashboard/` — the static page (board, detail view, filters); renders offline from `data.js`.
- `screenshots/` — the board, a protocol detail and a filtered view, as the judge sees them.
- `vendor/makefun-board.ts` — the vendored make.fun dossier library.
