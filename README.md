# MatchSim — Cricket Match Simulator

A from-scratch cricket match simulation engine with a full player database, team builder, tournaments, and multi-group/knockout seasons — all running client-side, no backend.

**Live app:** open `index.html` (or the GitHub Pages URL once deployed).

## Features
- **Player DB** — create and edit players (batting/bowling ratings, skills, batting hand, 10 bowling styles, wicketkeeper flag)
- **Select Teams** — build named, colored squads from the player pool (one player, one team)
- **Quick Match** — simulate a single match ball-by-ball, with full scorecards and a Man of the Match
- **Tournament** — simple round-robin across any set of full squads
- **Seasons** — groups + knockout rounds + standings (points, NRR), fixtures auto-simulated by the engine
- **Stats & History** — all-time leaderboards (batting, bowling, wicketkeeping) and a deletable match history
- **10 preset real-world grounds** with historically-grounded pitch ratings, or fully custom conditions

Everything is saved to the browser's `localStorage` — no server, no account, no sync between devices. Use "Download DB" / "Restore DB" (Stats & History tab) to back up or move your data between devices.

## Tech
Single-file vanilla JS + HTML/CSS (`index.html`). `cricket-sim.js` is a standalone Node-runnable copy of the same simulation engine, useful for reference or scripting outside the browser.

## Installing as an app
Open the GitHub Pages link on your phone or desktop and use your browser's "Add to Home Screen" / "Install" option — this project already includes a manifest and service worker for that.
