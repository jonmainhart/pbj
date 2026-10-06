# PBJ Dashboard

PBJ Dashboard is a lightweight, mobile-friendly dashboard for our weekly
football pool.

The commissioner's spreadsheet remains the source for player picks. PBJ
Dashboard consumes a CSV export and adds automatic game updates, scoring,
season statistics, and a simple public website.

No player accounts, online pick submission, or database are required.

## What It Does

Each week, players pick the winner of every NFL game and provide a tiebreaker
prediction for the combined score of the Monday night game or games.

PBJ Dashboard:

- Creates the weekly NFL schedule.
- Imports player picks from CSV.
- Updates game scores and statuses.
- Calculates weekly records and Win %.
- Determines weekly rankings and winners.
- Applies the Monday night tiebreaker when necessary.
- Tracks season statistics.
- Publishes results through GitHub Pages.

Routine production processing is automated with GitHub Actions.

## Pool Rules

### Weekly Picks and Scoring

Each week, players pick the winner of every NFL game and provide a tiebreaker
prediction for the combined score of the Monday night game or games.

Only final games affect player statistics.

- A correct pick is a win.
- An incorrect pick is a loss.
- An NFL tie is recorded as a tie for players who made a pick.
- A missing or explicit N/P is a loss and a missed pick once the game is final.
- Scheduled and live games do not yet affect statistics.

Missed picks are included in losses and are also tracked separately.

Win % is calculated as `(wins + 0.5 × ties) / (wins + losses + ties)`.
A tie therefore contributes half a win for Win % purposes. Missing-pick losses
are included normally.

### Weekly Ranking and Winner

Weekly standings become official only after every game for the week is final.
They are ranked by:

1. Most wins.
2. Closest Monday night tiebreaker prediction.

A player's tiebreaker distance is the absolute difference between their
prediction and the final Monday total. If multiple Monday games are played,
their final scores are combined into one Monday total.

Competition ranking is used. Players with identical wins and tiebreaker
distance share a rank, and the following rank skips the occupied positions.
For example: `1, 2, 2, 4`.

Every player ranked first is a weekly winner. If multiple players remain tied
for first, the weekly win is split between them. Each player in a split receives
one weekly win for season tracking.

Every player sharing the lowest final weekly rank receives a last-place finish.

### Season Ranking

Season standings use results from completed weeks and are ranked by:

1. Total wins.
2. Win %.

Players with identical wins and Win % share a competition rank. No additional
statistic breaks a season ranking tie.

Weekly wins and last-place finishes are tracked as season statistics but do not
affect season ranking.

### Elimination

During an incomplete week, a player remains in contention if any possible
combination of winners in the unfinished games allows that player to finish
tied for the most wins. A player is mathematically eliminated only when no such
combination remains.

Elimination is based on current wins, the unfinished games, and each player's
remaining picks. The Monday night tiebreaker is not used to eliminate a player
early; reaching a tie for the most wins is enough to remain in contention.

Elimination is informational only. It does not change scoring, official
rankings, or tiebreaker calculations. Once every game is final, the completed
weekly ranking is authoritative.

## Season Statistics

PBJ Dashboard tracks:

- Weeks played
- Wins
- Losses
- Ties
- Missed picks
- Win %
- Weekly wins
- Last-place finishes

Season statistics are rebuilt from completed weekly results, allowing
corrections to earlier weeks to propagate cleanly.

## Dashboard

The public site is a static HTML, CSS, and JavaScript application designed
primarily for phones.

It provides weekly and season views, game progress, weekly winners, player
records, individual picks, tiebreaker results, season statistics, and optional
announcements.

Player cards remain compact until selected, then open to show detailed
statistics and picks.

The weekly Players/Games toggle provides two views of the same picks. Players
is the default. Games shows each matchup and groups players by their selected
team or N/P. Unfinished games appear first, with kickoff order preserved within
the unfinished and final groups.

Select a matchup in a player card to open its game, or select a player in a
game card to open their picks. Closing returns to the originating card and
restores its scroll position. A second cross-navigation starts a new root
context rather than building a history chain.

Scheduled games show their local kickoff time. Live and final games show their
current or final score.

During an incomplete week, players still in contention are shown ahead of
eliminated players, separated by an `ELIMINATED` divider.

Pick indicators include:

- `✅` Correct
- `❌` Incorrect
- `➖` NFL tie
- `🟢` Live — pick is currently winning or tied
- `🟡` Live — pick is currently losing
- `⏳` Pending
- `⏳ N/P` Pending non-pick
- `❌ N/P` Final non-pick

Weekly winners are marked with `🏆`.

Players finishing last in a completed week are marked with `💩`. All players
sharing the lowest final rank receive the indicator.

The season view uses:

- `👑` for the current first-place player.
- `🏆` for each player's number of weekly wins.
- `💩` for each player's number of last-place finishes.

The last-place count is hidden when a player has no last-place finishes.

## Weekly Workflow

The normal workflow is:

1. PBJ Dashboard creates the week's NFL schedule.
2. The commissioner exports player picks to CSV.
3. Pushing the CSV imports the picks.
4. The week is rescored and season statistics are rebuilt after player changes.
5. Game data is updated automatically around NFL game times.
6. Weekly results are recalculated as games finish.
7. Season statistics are rebuilt after scoring changes.

Invalid CSV imports do not replace existing player data.

Generated weekly data is stored under `data/<season>/`.

## Announcements

Optional announcements can be placed in:

- `assets/announcement-top.txt`
- `assets/announcement-bottom.txt`

Empty announcement files remain hidden.

## Local Development

Install the project and development dependencies:

    python -m pip install ".[dev]"

Run the quality checks:

    pytest
    mypy src tests
    ruff check .

Install frontend test dependencies and Chromium:

    npm ci
    npx playwright install chromium

Run frontend unit and browser tests:

    node --test tests/frontend/unit/*.test.js
    npx playwright test

Browser tests start a local Python static server automatically. Automated
browser coverage uses Chromium; mobile Safari layout is checked manually.

Serve the dashboard locally:

    python -m http.server 8000

Then open `http://localhost:8000`.

Normal production processing is handled by GitHub Actions.

See [DEVELOPMENT.md](DEVELOPMENT.md) for architecture, data ownership,
scoring rules, automation, and development details.

## Data Source

NFL schedules, statuses, and scores are obtained through an isolated
provider layer.

BALLDONTLIE.io is the preferred data provider with ESPN as a fallback option if necessary.

## License

PBJ Dashboard source code and project documentation are licensed under the
Apache License 2.0.

Pool participant data under `data/` and PBJ artwork and branding under
`assets/img/` are expressly excluded from the Apache license. Third-party
sports data, team identifiers, trademarks, and other third-party material are
not licensed by this project.

See [LICENSE](LICENSE) and [LICENSE-SCOPE.md](LICENSE-SCOPE.md) for details.
