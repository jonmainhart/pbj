# PBJ Dashboard Development Notes

PBJ Dashboard is a static dashboard for a weekly football pool.

The commissioner's spreadsheet remains the source for player picks. PBJ
Dashboard consumes CSV exports, obtains NFL data from a Game Data Provider, derives weekly and
season results, and publishes the generated data through a static frontend.

## Design Principles

- Preserve the commissioner's spreadsheet workflow.
- Keep hosting and infrastructure simple.
- Prioritize mobile usability.
- Keep authoritative and derived data separate.
- Isolate external services behind provider interfaces.
- Make derived data reproducible.
- Prefer simple designs that are easy to change.

## Architecture

The primary data flow is:

    Spreadsheet → CSV → player data
    Game Data Provider → game data
    Games + players → weekly results → season results

GitHub Actions performs routine production processing. The browser reads
generated JSON and handles presentation only.

## Data

Weekly data is stored in `data/<season>/weekNN.json` and contains:

- `season`
- `week`
- `lock_time`
- `games`
- `players`
- `results`

Season statistics are stored in `data/<season>/season.json`.

### Games

Games use the provider-specific event ID as their stable identifier and retain only the
schedule, team, status, and score information PBJ Dashboard needs.

Normalized statuses are `scheduled`, `live`, and `final`.

Game winners are derived from final scores rather than persisted separately.
A score of zero is valid; status determines whether a score is meaningful.

### Players

Players have a stable ID, display name, optional nickname, picks, and a
tiebreaker prediction.

Picks are keyed by game ID and contain the selected team's abbreviation.
An absent game represents N/P.

## CSV Import

The importer matches matchup columns against the normalized NFL schedule and
normalizes known team-abbreviation aliases.

Import rules:

- Picks must match one of the teams playing the game.
- Blank picks are errors.
- Explicit `N/P` is accepted, omitted from normalized picks, and produces a warning.
- Spreadsheet scoring or `CORRECT` data is ignored.

A successful import atomically replaces player data. The week is then rescored
and season statistics are rebuilt so corrections propagate immediately.

A failed import leaves existing weekly data unchanged and preserves the CSV for
correction.

## Data Ownership

Each transformation owns part of the generated data:

- `update_games.py` — games and initial lock time
- `import_picks.py` — players
- `score_week.py` — weekly results
- `aggregate_season.py` — `season.json`
- `app.js` — presentation only

Each transformation must preserve data owned by the others.

Per-pick correctness is not persisted; it is derived from the player's pick and
the authoritative game result.

## Lock Time

Picks lock one hour before the scheduled kickoff of the first game of the week.

The lock time is established when the schedule is created and stored in weekly
data. Later schedule changes do not silently move it.

## Weekly Scoring

Only final games affect player statistics.

For a normal final game:

- Correct pick → win
- Incorrect pick → loss
- N/P → loss and missed pick

For an NFL tie:

- A player who made a pick receives a tie.
- N/P receives a loss and missed pick.

Scheduled and live games do not affect statistics.

`missed_picks` is a subset of losses, not an additional scoring outcome.

### Win %

Win % is:

    (wins + (0.5 * ties)) / (wins + losses + ties)

NFL ties contribute half a win for Win % purposes. N/P losses are included.
Win % is null when a player has no wins, losses, or ties.

The generated JSON retains the `accuracy` field name for compatibility.

## Weekly Completion and Ranking

A week is complete only when every game is final.

Until then:

- Final games contribute current statistics.
- Scheduled and live games do not.
- Weekly ranks and winners are unavailable.

Monday games are determined using `America/New_York`. If multiple Monday games
are played, their scores are combined into one Monday total. The total is
unavailable until every Monday game is final.

A player's tiebreaker distance is the absolute difference between their
prediction and the final Monday total.

Completed weeks are ranked by:

1. Most wins.
2. Smallest tiebreaker distance.

Equal wins and distance share a rank. Competition ranking is used, such as
`1, 2, 2, 4`.

Every player ranked first is a weekly winner and receives one weekly win for
season tracking.

Every player sharing the lowest final weekly rank receives a last-place finish.

## Season Aggregation

Completed weeks contribute:

- Weeks played
- Wins
- Losses
- Ties
- Missed picks
- Win %
- Weekly wins
- Last-place finishes

`season.json` is a deterministic derived cache. It is rebuilt from completed
weekly results rather than incrementally patched.

Season standings are presentation-ranked by:

1. Total wins, descending.
2. Win %, descending.

Players with equal wins and Win % share a rank. Competition ranking is used,
such as `1, 2, 2, 4`. No additional statistic breaks a season ranking tie.

Corrections to an earlier week therefore require rescoring that week and
rebuilding the season.

## Game Data Provider

Game data access is isolated behind the provider layer.

The provider converts provider-specific responses into PBJ domain objects. Scoring,
season aggregation, and presentation should not depend directly on provider
response structures.

Provider-specific responses terminate at the provider layer; scoring/season/presentation
remain provider-independent.

### Providers

BALLDONTLIE.io is the preferred game data provider as of week 4. This provider required an API
key.

ESPN.com is the rollback provider. It does not require an API key, but is not guaranteed to remain
available or stay consistent.

## Automation

Production processing uses:

- `create-week.yml`
- `import-picks.yml`
- `poll-games.yml`

The normal lifecycle is:

1. Create the weekly schedule.
2. Import the commissioner's CSV.
3. Update game data around NFL game times.
4. Score changed weekly data.
5. Rebuild season statistics.

Meaningful generated-data changes are committed by the workflows.

The 2026 season is currently explicit in the workflows.

### Polling

`poll-games.yml` is triggered every five minutes by an external scheduler using
GitHub's `workflow_dispatch` event. PBJ Dashboard then determines whether game
data actually needs to be refreshed.

Polling is required when:

- A scheduled game is between 15 minutes before and six hours after kickoff.
- Any game is live.

Final games do not independently require polling.

The active week is the earliest weekly file containing an unfinished game.
This prevents a future weekly file from blocking updates to an earlier
unfinished week.

Manual workflow dispatch can still be used when needed.

## Frontend

The frontend consists of `index.html`, `assets/style.css`, and native JavaScript
modules under `assets/`, with no frontend framework or build step.

Phone usability is the primary design requirement.

Player cards show compact weekly information and expand to show detailed picks.
Presentation state is derived in JavaScript:

Scheduled pick → ⏳
Live pick, selected team ahead or tied → 🟢
Live pick, selected team behind → 🟡
Final correct pick → ✅
Final incorrect pick → ❌
NFL tie → ➖
Scheduled/live N/P → ⏳ N/P
Final N/P → ❌ N/P

If scores are unavailable for a live game, the pick retains the generic 🟢 live state.

Scheduled games show localized kickoff times. Live and final games show scores.

During an incomplete week, the frontend derives mathematical elimination from
the current wins, remaining games, and player picks. A player remains in
contention if any possible combination of remaining game winners allows that
player to finish tied for the most wins.

Players still in contention are displayed first, followed by an `ELIMINATED`
divider and the remaining players. Within each group, players are sorted by
current wins.

Elimination is presentation-only state. It is not persisted and does not
participate in official scoring or tiebreaker calculations. Once the week is
complete, `weekly_rank` is authoritative.

Completed weekly winners are marked with `🏆`; players sharing the lowest final
rank are marked with `💩`.

The season view uses `👑` for the current first-place player, `🏆` for weekly
win counts, and `💩` for nonzero last-place-finish counts.

Python scoring remains authoritative. JavaScript presents the underlying state.

### Weekly Games View and Navigation

Players is the default weekly presentation. Games is derived from the same
weekly JSON without adding persisted pick data. Games are sorted by kickoff,
with unfinished games before final games; equal kickoff times retain input order.

`game-view-model.js` owns game ordering and team/N/P grouping. `pick-status.js`
contains the shared pick-status rules extracted from the Players view, and
`game-display.js` formats matchups and localized kickoff times for both views.

`weekly-navigation.js` defines pure state transitions with at most one return
context. `weekly-controller.js` connects those transitions to view selection,
stable entity IDs, focus, and page/card scroll snapshots. The shared overlay in
`player-card.js` handles both player and game cards, with delegated drill-down
events bound to the displayed clone.

A first cross-navigation saves the origin. Closing the destination restores
that origin once. A second cross-navigation discards the old return context
and makes the new destination a root. Explicit toggles, week changes, and
dashboard-tab changes clear navigation context. Changing weeks starts in Players.

Summary activation, Escape, and backdrop activation share the same close
behavior. Cards use named dialogs and keep keyboard focus within the overlay.
Refresh is suspended while either kind of card is open and retains the selected
weekly presentation when new data is rendered.

The season view is presentation-sorted by total wins, then Win %. Equal wins
and Win % share a competition rank.

## Announcements

Optional announcements are read from:

- `assets/announcement-top.txt`
- `assets/announcement-bottom.txt`

Empty files remain hidden. Existing line breaks are preserved.

## Development

Install or reinstall the project and development dependencies with:

    python -m pip install ".[dev]"

The project uses a `src/` layout and a non-editable install. Reinstall after
source changes when testing the installed package.

Do not use `PYTHONPATH=src` as part of the normal workflow.

### Manual Commands

    python scripts/update_games.py <season> <week>
    python scripts/import_picks.py <season> <week>
    python scripts/score_week.py <season> <week>
    python scripts/aggregate_season.py <season>
    python scripts/should_poll.py <season> <week>

For `should_poll.py`, exit code 0 means polling is required and exit code 1
means it is not. Other nonzero codes indicate errors.

### Testing and Quality

Before committing Python changes:

    pytest
    mypy src tests
    ruff check .

Coverage can be checked with:

    pytest --cov=pbj

Production code should contain no `print()` calls. Use logging for operational
messages and exceptions for failures.

Development follows a relaxed TDD cadence: add meaningful tests, implement the
behavior, run the checks, and refactor while keeping the suite green.

### Frontend Testing

Frontend tests use Node's built-in test runner for deterministic logic and
Playwright for browser interactions. No bundler, transpiler, or frontend
framework is required.

    npm ci
    npx playwright install chromium
    node --test tests/frontend/unit/*.test.js
    npx playwright test

Unit tests live in `tests/frontend/unit`; browser tests and synthetic JSON
fixtures live in `tests/frontend/browser`. Browser tests serve the real static
site and intercept data requests, independently of production participant data.
Playwright starts Python's static server on `127.0.0.1:8000` and can reuse an
existing local server outside CI.

Automated browser checks use desktop Chromium, including narrow-screen functional
checks. Mobile Safari is tested manually. Focus, scrolling, overflow, and usable
controls matter more than pixel-perfect snapshots.

## License

PBJ Dashboard source code and project documentation are licensed under the
Apache License 2.0.

Pool participant data under `data/` and PBJ artwork and branding under
`assets/img/` are expressly excluded from the Apache license. Third-party
sports data, team identifiers, trademarks, and other third-party material are
not licensed by this project.

See [LICENSE](LICENSE) and [LICENSE-SCOPE.md](LICENSE-SCOPE.md) for details.
