# PBJ Dashboard

PBJ Dashboard is a lightweight, mobile-friendly dashboard for our weekly football pool.

The commissioner's spreadsheet remains the source for player picks. PBJ imports those picks, updates NFL game results, calculates weekly and season standings, and publishes everything through a public website.

No player accounts, online pick submission, or database are required.

## What It Does

- Creates the weekly NFL schedule.
- Imports player picks from CSV.
- Updates game scores and statuses.
- Calculates weekly results and winners.
- Applies the Monday night tiebreaker.
- Tracks season standings and statistics.
- Shows mathematical elimination during incomplete weeks.
- Publishes results through GitHub Pages.

Routine production processing is automated with GitHub Actions.

## Pool Rules

See [Pool Rules](RULES.md) for:

- Weekly scoring
- Weekly rankings and winners
- Monday night tiebreakers
- Season standings
- Mathematical elimination
- Dashboard status indicators

`RULES.md` is the source of truth for pool rules displayed by the dashboard.

The dashboard's footer includes a Rules control that opens the complete rules
without leaving the current view.

## Dashboard

The public site provides weekly and season views, game progress, player picks, weekly winners, tiebreaker results, season statistics, and announcements.

The weekly view can be displayed by player or by game.

During an incomplete week, players still in contention appear ahead of mathematically eliminated players.

## Weekly Workflow

1. PBJ creates the week's NFL schedule.
2. The commissioner enters picks and sends the completed CSV.
3. The CSV is added to the repository.
4. PBJ imports and publishes the picks.
5. Scores and game statuses update automatically.
6. Weekly and season results update as games become final.

Invalid CSV imports do not replace existing player data.

Generated weekly data is stored under `data/<season>/`.

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md) for architecture, data ownership, scoring implementation, game-data providers, automation, testing, and local development.

## License

PBJ Dashboard source code and project documentation are licensed under the Apache License 2.0.

Pool participant data and PBJ artwork and branding are excluded from that license. Third-party sports data, team identifiers, trademarks, and other third-party material remain subject to their respective rights.

See [LICENSE](LICENSE) and [LICENSE-SCOPE.md](LICENSE-SCOPE.md) for details.

The dashboard footer opens the Apache 2.0 license and Data & artwork terms
without leaving the current view.
