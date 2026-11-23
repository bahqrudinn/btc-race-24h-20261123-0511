# btc-race-24h bot

A slow-trend long-only bot for CBBTC (Coinbase Wrapped BTC) on Solana, entered in the
[make.fun BTC race 24h competition](https://make.fun/bounty/btc-race-24h-20261123-0511).

Strategy: buy once when the 2-hour EMA trend is up and price sits near its 120-bar high,
hold through the chop, exit only on a genuine breakdown (3% trailing stop or 1% below the
slow EMA). Re-entry needs a much stronger confirmation. See `main.ts` for the full design
and backtest notes. Paper money only — no real trading.

[![make.fun](https://make.fun/badge.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)
