# PBJ Dashboard Development Notes

PBJ Dashboard is a static dashboard for a weekly football pool.

The commissioner's spreadsheet remains the source for player picks. PBJ Dashboard consumes CSV exports, obtains NFL data from a Game Data Provider, derives weekly and season results, and publishes the generated data through a static frontend.

Player-facing pool rules are documented in [RULES.md](RULES.md). This document describes how PBJ implements those rules and how the application is developed and operated.

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

GitHub Actions performs routine production processing. The browser reads generated JSON and handles presentation only.

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

Games use the provider-specific event ID as their stable identifier and retain only the schedule, team, status, and score information PBJ Dashboard needs.

Normalized statuses are `scheduled`, `live`, and `final`.

Game winners are derived from final scores rather than persisted separately. A score of zero is valid; status determines whether a score is meaningful.

### Players

Players have a stable ID, display name, optional nickname, picks, and a tiebreaker prediction.

Picks are keyed by game ID and contain the selected team's abbreviation. An absent game represents N/P.

## CSV Import

The importer matches matchup columns against the normalized NFL schedule and normalizes known team-abbreviation aliases.

Import rules:

- Picks must match one of the teams playing the game.
- Blank picks are errors.
- Explicit `N/P` is accepted, omitted from normalized picks, and produces a warning.
- Spreadsheet scoring or `CORRECT` data is ignored.

A successful import atomically replaces player data. The week is then rescored and season statistics are rebuilt so corrections propagate immediately.

A failed import leaves existing weekly data unchanged and preserves the CSV for correction.

## Data Ownership

Each transformation owns part of the generated data:

- `update_games.py` — games and initial lock time
- `import_picks.py` — players
- `score_week.py` — weekly results
- `aggregate_season.py` — `season.json`
- `app.js` — presentation only

Each transformation must preserve data owned by the others.

Per-pick correctness is not persisted; it is derived from the player's pick and the authoritative game result.

## Lock Time

Picks lock one hour before the scheduled kickoff of the first game of the week.

The lock time is established when the schedule is created and stored in weekly data. Later schedule changes do not silently move it.

## Weekly Scoring

See [RULES.md](RULES.md) for the player-facing scoring rules. The details below describe their implementation and generated-data behavior.

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

NFL ties contribute half a win for Win % purposes. N/P losses are included. Win % is null when a player has no wins, losses, or ties.

The generated JSON retains the `accuracy` field name for compatibility.

## Weekly Completion and Ranking

A week is complete only when every game is final.

Until then:

- Final games contribute current statistics.
- Scheduled and live games do not.
- Weekly ranks and winners are unavailable.

Monday games are determined using `America/New_York`. If multiple Monday games are played, their scores are combined into one Monday total. The total is unavailable until every Monday game is final.

A player's tiebreaker distance is the absolute difference between their prediction and the final Monday total.

Completed weeks are ranked by:

1. Most wins.
2. Smallest tiebreaker distance.

Equal wins and distance share a rank. Competition ranking is used, such as `1, 2, 2, 4`.

Every player ranked first is a weekly winner and receives one weekly win for season tracking.

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

`season.json` is a deterministic derived cache. It is rebuilt from completed weekly results rather than incrementally patched.

Season standings are presentation-ranked by:

1. Total wins, descending.
2. Win %, descending.

Players with equal wins and Win % share a rank. Competition ranking is used, such as `1, 2, 2, 4`. No additional statistic breaks a season ranking tie.

Corrections to an earlier week therefore require rescoring that week and rebuilding the season.

## Game Data Provider

Game data access is isolated behind the provider layer.

The provider converts provider-specific responses into PBJ domain objects. Scoring, season aggregation, and presentation should not depend directly on provider response structures.

Provider-specific responses terminate at the provider layer; scoring, season aggregation, and presentation remain provider-independent.

### Providers

BALLDONTLIE.io is the preferred game data provider as of Week 4 of the 2026 season. It requires an API key.

ESPN.com is the rollback provider. It does not require an API key but is not guaranteed to remain available or consistent.

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

`poll-games.yml` is triggered every five minutes by an external scheduler using GitHub's `workflow_dispatch` event. PBJ Dashboard then determines whether game data actually needs to be refreshed.

Polling is required when:

- A scheduled game is between 15 minutes before and six hours after kickoff.
- Any game is live.

Final games do not independently require polling.

The active week is the earliest weekly file containing an unfinished game. This prevents a future weekly file from blocking updates to an earlier unfinished week.

Manual workflow dispatch can still be used when needed.

## Frontend

The frontend consists of `index.html`, `assets/style.css`, and native JavaScript modules under `assets/`, with no frontend framework or JavaScript build step. Python generates document HTML when preparing the static site.

Phone usability is the primary design requirement.

Player cards show compact weekly information and expand to show detailed picks. Presentation state is derived in JavaScript:

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

During an incomplete week, the frontend derives mathematical elimination from current wins, remaining games, and player picks. A player remains in contention if any possible combination of remaining game winners allows that player to finish tied for the most wins.

The tiebreaker is intentionally excluded from elimination. A player who can still tie for the most wins remains in contention.

Players still in contention are displayed first, followed by an `ELIMINATED` divider and the remaining players. Within each group, players are sorted by current wins.

Elimination is presentation-only state. It is not persisted and does not participate in scoring or tiebreaker calculations. Once the week is complete, `weekly_rank` is authoritative.

Completed weekly winners are marked with `🏆`; players sharing the lowest final rank are marked with `💩`.

The season view uses `👑` for the current first-place player, `🏆` for weekly win counts, and `💩` for nonzero last-place-finish counts.

Python scoring remains authoritative. JavaScript presents the underlying state.

### Responsive Card Layout

Weekly player and season standings lists remain single-column at every viewport width. The previous 600px two-column resting-card layout is intentionally removed, including for larger phones in landscape.

At viewport widths of 800px and above, weekly resting cards use a wide, shallow two-row layout: the player name and prominent W-L-T record appear above a compact sequence of picks in game order, alongside Win %. The compact pick row uses the same status indicators and colors as the detailed pick list, includes N/P, and does not wrap into matchup-like rows. Tiebreaker values remain in the expanded details, and weekly ranks and winner treatments remain unavailable until the week is complete. The eliminated-player divider remains the sole resting-list elimination label.

Compact picks are presentation-only elements on resting cards. `weekly.js` creates them from existing game and pick data; `player-card.js` removes `.compact-picks` when cloning a card into the foreground overlay, preserving the expanded card's detailed pick list. No new data is persisted.

At the same breakpoint, season standings use wide, shallow single-column cards while preserving the season record, Win %, weeks played, missed picks, and finish indicators. Below 800px, both lists retain their smaller-screen card presentation.

### Weekly Games View and Navigation

Players is the default weekly presentation. Games is derived from the same weekly JSON without adding persisted pick data. Games are sorted by kickoff, with unfinished games before final games; equal kickoff times retain input order.

`game-view-model.js` owns game ordering and team/N/P grouping. `pick-status.js` contains the shared pick-status rules extracted from the Players view, and `game-display.js` formats matchups and localized kickoff times for both views.

`weekly-navigation.js` defines pure state transitions with at most one return context. `weekly-controller.js` connects those transitions to view selection, stable entity IDs, focus, and page/card scroll snapshots. `player-card.js` handles player and game clones and delegated drill-down events; `foreground-card.js` owns the shared overlay, keyboard containment, and scroll locking for all foreground cards.

A first cross-navigation saves the origin. Closing the destination restores that origin once. A second cross-navigation discards the old return context and makes the new destination a root. Explicit toggles, week changes, and dashboard-tab changes clear navigation context. Changing weeks starts in Players.

Summary activation, Escape, and backdrop activation share the same close behavior. Cards use named dialogs and keep keyboard focus within the overlay. Refresh is suspended while any foreground card is open and retains the selected weekly presentation when new data is rendered.

The season view is presentation-sorted by total wins, then Win %. Equal wins and Win % share a competition rank.

### Document Cards and Publishing

The footer Rules, Apache 2.0, Data & artwork terms, and Legal Notice controls open scrollable document cards without changing dashboard navigation. `document-card.js` owns loading, errors, and document-specific dismissal; `documents.js` fetches generated HTML. All document cards use the shared foreground-card behavior, including Close, backdrop dismissal, and Escape. Closing restores trigger focus and page scroll while retaining the current dashboard view and selected week. Late responses are ignored after dismissal.

`scripts/generate_documents.py` generates dashboard presentation from the complete repository source documents:

- `RULES.md` → `assets/documents/rules.html`, rendered using CommonMark.
- `LICENSE` → `assets/documents/license.html`, rendered as escaped plain-text paragraphs.
- `LICENSE-SCOPE.md` → `assets/documents/license-scope.html`, rendered using CommonMark.
- `LEGAL.md` → `assets/documents/legal.html`, rendered using CommonMark.

Raw HTML is disabled for Markdown sources. Plain-text rendering preserves wording and paragraph boundaries, joining source lines within each paragraph so the browser wraps text naturally at the available width. Keep `LICENSE` as extensionless plain text. Edit the source documents rather than maintaining presentation copies; generated `assets/documents/` files are ignored by Git.

The sticky card header uses a document's opening `<h1>` when present, otherwise its configured title. The header keeps Close usable while long documents scroll.

Before serving the repository locally, generate the documents:

    python -m scripts.generate_documents
    python -m http.server 8000 --bind 127.0.0.1

Regenerate after editing `RULES.md`, `LICENSE`, `LICENSE-SCOPE.md`, or `LEGAL.md`. To preview the production artifact instead:

    python -m scripts.build_site
    python -m http.server 8000 --bind 127.0.0.1 --directory build/site

The builder replaces `build/site` with public root files, assets, dashboard JSON, and freshly generated documents. The original `LICENSE`, `LICENSE-SCOPE.md`, and `LEGAL.md` files remain directly available in the published artifact. CSV imports, raw provider responses, Python source, and development files are excluded. The normal deployment rebuilds document presentation after source edits.

`deploy-pages.yml` builds and publishes this artifact after relevant changes on `main`, manual dispatch, or successful production data-processing workflows. The latter handles bot commits, which do not trigger another push workflow. Processing runs without a new commit skip publication. Pending runs queue so no-op processing runs cannot replace pending production deployments; running deployments are not canceled. Configure the repository's **Settings → Pages → Source** as **GitHub Actions** before using this deployment workflow. Manual deployment also builds `main`.

## Announcements

Optional announcements are read from:

- `assets/announcement-top.txt`
- `assets/announcement-bottom.txt`

Empty files remain hidden. Existing line breaks are preserved.

## Development

Install or reinstall the project and development dependencies with:

    python -m pip install ".[dev]"

The project uses a `src/` layout and a non-editable install. Reinstall after source changes when testing the installed package.

Do not use `PYTHONPATH=src` as part of the normal workflow.

### Manual Commands

    python scripts/update_games.py <season> <week>
    python scripts/import_picks.py <season> <week>
    python scripts/score_week.py <season> <week>
    python scripts/aggregate_season.py <season>
    python scripts/should_poll.py <season> <week>

For `should_poll.py`, exit code 0 means polling is required and exit code 1 means it is not. Other nonzero codes indicate errors.

### Testing and Quality

Before committing Python changes:

    pytest
    mypy src tests
    ruff check .

Coverage can be checked with:

    pytest --cov=pbj

Production code should contain no `print()` calls. Use logging for operational messages and exceptions for failures.

Development follows a relaxed TDD cadence: add meaningful tests, implement the behavior, run the checks, and refactor while keeping the suite green.

### Frontend Testing

Frontend tests use Node's built-in test runner for deterministic logic and Playwright for browser interactions. No bundler, transpiler, or frontend framework is required.

    npm ci
    npx playwright install chromium
    node --test tests/frontend/unit/*.test.js
    npx playwright test

Unit tests live in `tests/frontend/unit`; browser tests and synthetic JSON fixtures live in `tests/frontend/browser`. Browser tests serve the real static site and intercept data requests, independently of production participant data. Playwright starts Python's static server on `127.0.0.1:8000` and can reuse an existing local server outside CI.

Playwright's global setup regenerates document assets before every run, including when reusing a server. It uses `.venv/bin/python` when present, otherwise `python3`; set `PBJ_PYTHON` to select another interpreter with the document dependencies installed. Shared document behavior is tested with synthetic HTML, and browser tests also load the real generated Rules, license, and scope assets. License checks cover complete paragraph content, natural wrapping, phone and desktop scrolling, horizontal overflow, usable Close controls, and restoration of trigger focus and dashboard state. Python tests cover escaping, paragraph boundaries, and regeneration from source documents while preserving the original files in the published artifact.

Responsive card browser tests in `tests/frontend/browser/card-layout.spec.js` cover single-column ordering across phone, intermediate, and desktop widths; the 799px/800px layout boundary; 16 compact picks without wrapping; status indicators; preservation of expanded details; and season-card content.

Automated browser checks use desktop Chromium, including narrow-screen functional checks. Mobile Safari is tested manually. Focus, scrolling, overflow, and usable controls matter more than pixel-perfect snapshots.

## License

PBJ Dashboard source code and project documentation are licensed under the Apache License 2.0.

Pool participant data under `data/` and PBJ artwork and branding under `assets/img/` are expressly excluded from the Apache license. Third-party sports data, team identifiers, trademarks, and other third-party material are not licensed by this project.

See [LICENSE](LICENSE) and [LICENSE-SCOPE.md](LICENSE-SCOPE.md) for details.
