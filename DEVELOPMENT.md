# PBJ development

## Setup

Use Python 3.11 or later and a supported Node version from [package.json](package.json); CI uses Python 3.14 and Node 22. From the repository root:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install '.[dev,aws]'
npm ci
npx playwright install chromium
```

PBJ uses a `src/` layout and a non-editable Python install. Reinstall `.[dev,aws]` after changing Python package source or dependencies; otherwise tests can import an older installed copy. Local tests use fixtures and mocked AWS services and do not require AWS credentials. Fetching real game data or running deployment commands does require the relevant credentials and network access.

## Build and preview

```bash
npm run build:admin
python -m scripts.build_site
python -m http.server 8000 --bind 127.0.0.1 --directory build/site
```

Open `http://127.0.0.1:8000/`. Rebuild after changing website source, public data, or source documents. The admin CSS build is needed after changes to portal styling. The static admin shell has no local Cognito/API configuration by default; browser tests mock it.

`scripts.build_site` replaces `build/site` with an allowlisted artifact: static site assets, public weekly/season JSON, and generated documents. It excludes CSVs, raw responses, source code, and runtime-managed announcements. `RULES.md`, `LICENSE`, `LICENSE-SCOPE.md`, and `LEGAL.md` are authoritative; edit those files when appropriate, not generated HTML. To regenerate documents without rebuilding the whole site:

```bash
python -m scripts.generate_documents
```

## Tests and quality checks

```bash
ruff check .
ruff format --check .
mypy src scripts aws tests/python
pytest
npm run build:admin
npm run lint
npm run test:unit
npm run test:browser
```

`pytest` includes Python unit and integration-style tests with mocked services. To focus on the offline AWS artifact and publication boundaries:

```bash
pytest -q tests/python/test_aws_artifact.py tests/python/test_aws_preview.py tests/python/test_aws_processing.py tests/python/test_build_site.py
```

Run the tagged smoke suites with:

```bash
pytest -m smoke -q
npx playwright test --grep @smoke
```

For optional coverage use `pytest --cov=pbj`. Playwright rebuilds the site and starts a local server on `127.0.0.1:8000`; keep that port free. It uses `.venv/bin/python` if present, or `python3`; `PBJ_PYTHON` selects another interpreter. Browser tests use Chromium and mocked responses, including narrow viewports. Check Mobile Safari and real devices separately when relevant.

The [quality workflow](.github/workflows/quality.yml) selects checks by changed paths and validates tracked JSON; manual runs and unknown paths select full checks. It is a QA signal, not a branch-protection rule. The optional local Git hook is checkout-specific; CI remains authoritative for its configured checks.

## Responsibilities and data boundaries

- `src/pbj/`: domain models, providers, CSV import, scoring, season aggregation, polling decisions, and weekly-data parsing; no AWS dependencies.
- `scripts/`: command-line and reusable file operations. `update_games` owns games and the initial lock time, `import_picks` owns players, `score_week` owns weekly results, and `aggregate_season` owns `season.json`. Preserve fields owned by other operations.
- `aws/`: storage, orchestration, authorization, deployment, and infrastructure. Lambda reuses the same Python package and scripts. Conditional writes and repeated aggregation support concurrency and recovery.
- `site/`: static dashboard and commissioner portal. The dashboard derives presentation from JSON; it lazily loads historical names and fetches current week data fresh. The portal maintains private drafts and uses the API for authorized changes.
- `tests/`: Python tests and frontend unit/browser tests. Browser fixtures and mocked AWS tests must remain deterministic without live services.

Weekly documents live at `data/<season>/weekNN.json`; season results at `data/<season>/season.json`, and `data/available-weeks.json` lists published weeks. Preserve these public formats and URLs. Game IDs are stable provider identifiers. Lock time is established on schedule creation and is not silently moved on later updates. CSV import validates matchups, accepts known team aliases and explicit `N/P`, leaves existing data unchanged if validation fails, and removes its input only after a successful write. See [RULES.md](RULES.md) for pool rules.

GitHub Pages production uses repository data from `main`; AWS preview serves separately maintained operational JSON. The static preview uploader does not publish or replace AWS operational data. See [AWS operations](aws/README.md) before changing publication, authentication, drafts, or recovery.

## Local processing commands

Run against a disposable copy of `data/` when experimenting; these commands can modify local files. BALLDONTLIE access requires `BALLDONTLIE_API_KEY` for a real fetch; the ESPN provider is an alternative where available.

```bash
python scripts/update_games.py <season> <week> --provider balldontlie
python scripts/import_picks.py <season> <week>
python scripts/score_week.py <season> <week>
python scripts/aggregate_season.py <season>
python scripts/should_poll.py <season> <week>
python scripts/generate_manifest.py
```

`should_poll.py` exits 0 when a poll is needed, 1 when it is not, and uses other nonzero codes for errors. Production's GitHub workflows create schedules, import CSVs, poll games, and commit generated data; Pages publishes the resulting artifact. Keep operational data and credentials out of the static source and build inputs.
