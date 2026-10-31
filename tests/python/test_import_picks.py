"""Tests for the weekly picks import script."""

import json
from pathlib import Path
from typing import Any

import pytest

from pbj.domain.player import Player
from scripts import import_picks


def _week_data(
    *,
    season: int = 2026,
    week: int = 2,
) -> dict[str, Any]:
    """Build normalized weekly JSON for script tests."""
    return {
        "season": season,
        "week": week,
        "games": [
            {
                "id": "game-1",
                "scheduled_time": ("2026-09-17T00:20:00+00:00"),
                "away": {
                    "id": "1",
                    "abbreviation": "NE",
                    "name": "New England Patriots",
                },
                "home": {
                    "id": "2",
                    "abbreviation": "SEA",
                    "name": "Seattle Seahawks",
                },
                "status": "scheduled",
                "away_score": 0,
                "home_score": 0,
            },
            {
                "id": "game-2",
                "scheduled_time": ("2026-09-20T17:00:00+00:00"),
                "away": {
                    "id": "3",
                    "abbreviation": "BUF",
                    "name": "Buffalo Bills",
                },
                "home": {
                    "id": "4",
                    "abbreviation": "MIA",
                    "name": "Miami Dolphins",
                },
                "status": "scheduled",
                "away_score": 0,
                "home_score": 0,
            },
        ],
        "lock_time": "2026-09-16T23:20:00+00:00",
        "players": [
            {
                "id": "old-player",
                "name": "Old Player",
                "nickname": None,
                "picks": {
                    "game-1": "NE",
                    "game-2": "BUF",
                },
                "tiebreaker": 40.0,
            },
        ],
        "results": {
            "monday_total": None,
            "player_count": 1,
            "weekly_winners": [],
            "players": [],
        },
    }


def _players() -> list[Player]:
    """Build imported players for script tests."""
    return [
        Player(
            id="abigail",
            name="Abigail",
            nickname=None,
            picks={
                "game-1": "SEA",
                "game-2": "BUF",
            },
            tiebreaker=47.0,
        ),
        Player(
            id="bob",
            name="Bob",
            nickname=None,
            picks={
                "game-1": "NE",
                "game-2": "MIA",
            },
            tiebreaker=44.0,
        ),
    ]


def _write_json(
    path: Path,
    data: dict[str, Any],
) -> None:
    """Write JSON test data."""
    path.write_text(
        json.dumps(data),
        encoding="utf-8",
    )


def _read_json(
    path: Path,
) -> dict[str, Any]:
    """Read JSON test data."""
    data: Any = json.loads(
        path.read_text(
            encoding="utf-8",
        )
    )

    if not isinstance(data, dict):
        raise ValueError("test JSON must contain an object")

    return data


def _make_csv(
    path: Path,
) -> None:
    """Create placeholder CSV input for orchestration tests."""
    path.write_text(
        "test csv input\n",
        encoding="utf-8",
    )


@pytest.mark.unit
def test_default_csv_path() -> None:
    """Default CSV lives beside the normalized weekly JSON."""
    path = import_picks._default_csv_path(
        season=2026,
        week=2,
    )

    assert path == Path("data/2026/week02.csv")


@pytest.mark.unit
@pytest.mark.smoke
def test_import_replaces_players(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Imported players replace the weekly players section."""
    week_path = tmp_path / "week02.json"
    csv_path = tmp_path / "week02.csv"

    _write_json(
        week_path,
        _week_data(),
    )
    _make_csv(csv_path)

    monkeypatch.setattr(
        import_picks,
        "import_players",
        lambda _csv_file, _games: _players(),
    )

    import_picks.import_picks_file(
        week_path=week_path,
        csv_path=csv_path,
        season=2026,
        week=2,
    )

    data = _read_json(week_path)

    assert [player["id"] for player in data["players"]] == [
        "abigail",
        "bob",
    ]


@pytest.mark.unit
def test_import_preserves_games(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Importing picks does not modify game data."""
    week_path = tmp_path / "week02.json"
    csv_path = tmp_path / "week02.csv"

    original = _week_data()

    _write_json(
        week_path,
        original,
    )
    _make_csv(csv_path)

    monkeypatch.setattr(
        import_picks,
        "import_players",
        lambda _csv_file, _games: _players(),
    )

    import_picks.import_picks_file(
        week_path=week_path,
        csv_path=csv_path,
        season=2026,
        week=2,
    )

    data = _read_json(week_path)

    assert data["games"] == original["games"]


@pytest.mark.unit
def test_import_preserves_results(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Importing picks does not modify derived results."""
    week_path = tmp_path / "week02.json"
    csv_path = tmp_path / "week02.csv"

    original = _week_data()

    _write_json(
        week_path,
        original,
    )
    _make_csv(csv_path)

    monkeypatch.setattr(
        import_picks,
        "import_players",
        lambda _csv_file, _games: _players(),
    )

    import_picks.import_picks_file(
        week_path=week_path,
        csv_path=csv_path,
        season=2026,
        week=2,
    )

    data = _read_json(week_path)

    assert data["results"] == original["results"]


@pytest.mark.unit
def test_import_preserves_lock_time(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Importing picks does not modify the established lock time."""
    week_path = tmp_path / "week02.json"
    csv_path = tmp_path / "week02.csv"

    original = _week_data()

    _write_json(
        week_path,
        original,
    )
    _make_csv(csv_path)

    monkeypatch.setattr(
        import_picks,
        "import_players",
        lambda _csv_file, _games: _players(),
    )

    import_picks.import_picks_file(
        week_path=week_path,
        csv_path=csv_path,
        season=2026,
        week=2,
    )

    data = _read_json(week_path)

    assert data["lock_time"] == original["lock_time"]


@pytest.mark.unit
def test_successful_import_removes_csv(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """CSV is removed after weekly JSON is successfully persisted."""
    week_path = tmp_path / "week02.json"
    csv_path = tmp_path / "week02.csv"

    _write_json(
        week_path,
        _week_data(),
    )
    _make_csv(csv_path)

    monkeypatch.setattr(
        import_picks,
        "import_players",
        lambda _csv_file, _games: _players(),
    )

    import_picks.import_picks_file(
        week_path=week_path,
        csv_path=csv_path,
        season=2026,
        week=2,
    )

    assert week_path.exists()
    assert not csv_path.exists()


@pytest.mark.unit
@pytest.mark.smoke
def test_import_failure_preserves_csv(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """CSV remains when the picks importer fails."""
    week_path = tmp_path / "week02.json"
    csv_path = tmp_path / "week02.csv"

    _write_json(
        week_path,
        _week_data(),
    )
    _make_csv(csv_path)

    def fail_import(
        _csv_file: object,
        _games: object,
    ) -> list[Player]:
        raise ValueError("simulated import failure")

    monkeypatch.setattr(
        import_picks,
        "import_players",
        fail_import,
    )

    with pytest.raises(
        ValueError,
        match="simulated import failure",
    ):
        import_picks.import_picks_file(
            week_path=week_path,
            csv_path=csv_path,
            season=2026,
            week=2,
        )

    assert csv_path.exists()


@pytest.mark.unit
def test_json_write_failure_preserves_csv(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """CSV remains when normalized weekly JSON cannot be written."""
    week_path = tmp_path / "week02.json"
    csv_path = tmp_path / "week02.csv"

    _write_json(
        week_path,
        _week_data(),
    )
    _make_csv(csv_path)

    monkeypatch.setattr(
        import_picks,
        "import_players",
        lambda _csv_file, _games: _players(),
    )

    def fail_write(
        path: Path,
        data: dict[str, Any],
    ) -> None:
        raise OSError("simulated write failure")

    monkeypatch.setattr(
        import_picks,
        "_write_json_atomic",
        fail_write,
    )

    with pytest.raises(
        OSError,
        match="simulated write failure",
    ):
        import_picks.import_picks_file(
            week_path=week_path,
            csv_path=csv_path,
            season=2026,
            week=2,
        )

    assert csv_path.exists()


@pytest.mark.unit
def test_missing_csv_raises_error(
    tmp_path: Path,
) -> None:
    """Import requires the expected CSV input file."""
    week_path = tmp_path / "week02.json"
    csv_path = tmp_path / "week02.csv"

    _write_json(
        week_path,
        _week_data(),
    )

    with pytest.raises(
        FileNotFoundError,
        match=r"week02.csv",
    ):
        import_picks.import_picks_file(
            week_path=week_path,
            csv_path=csv_path,
            season=2026,
            week=2,
        )


@pytest.mark.unit
def test_requires_game_data(
    tmp_path: Path,
) -> None:
    """Picks cannot be resolved before the weekly schedule exists."""
    week_path = tmp_path / "week02.json"
    csv_path = tmp_path / "week02.csv"

    data = _week_data()
    data["games"] = []

    _write_json(
        week_path,
        data,
    )
    _make_csv(csv_path)

    with pytest.raises(
        ValueError,
        match="does not contain game data",
    ):
        import_picks.import_picks_file(
            week_path=week_path,
            csv_path=csv_path,
            season=2026,
            week=2,
        )

    assert csv_path.exists()


@pytest.mark.unit
def test_empty_import_preserves_csv(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An importer returning no players does not consume its CSV."""
    week_path = tmp_path / "week02.json"
    csv_path = tmp_path / "week02.csv"

    _write_json(
        week_path,
        _week_data(),
    )
    _make_csv(csv_path)

    monkeypatch.setattr(
        import_picks,
        "import_players",
        lambda _csv_file, _games: [],
    )

    with pytest.raises(
        ValueError,
        match="did not contain any players",
    ):
        import_picks.import_picks_file(
            week_path=week_path,
            csv_path=csv_path,
            season=2026,
            week=2,
        )

    assert csv_path.exists()


@pytest.mark.unit
def test_wrong_season_preserves_csv(
    tmp_path: Path,
) -> None:
    """A season mismatch fails before consuming the CSV."""
    week_path = tmp_path / "week02.json"
    csv_path = tmp_path / "week02.csv"

    _write_json(
        week_path,
        _week_data(
            season=2025,
        ),
    )
    _make_csv(csv_path)

    with pytest.raises(
        ValueError,
        match="contains season 2025, expected 2026",
    ):
        import_picks.import_picks_file(
            week_path=week_path,
            csv_path=csv_path,
            season=2026,
            week=2,
        )

    assert csv_path.exists()


@pytest.mark.unit
def test_wrong_week_preserves_csv(
    tmp_path: Path,
) -> None:
    """A week mismatch fails before consuming the CSV."""
    week_path = tmp_path / "week02.json"
    csv_path = tmp_path / "week02.csv"

    _write_json(
        week_path,
        _week_data(
            week=3,
        ),
    )
    _make_csv(csv_path)

    with pytest.raises(
        ValueError,
        match="contains week 3, expected 2",
    ):
        import_picks.import_picks_file(
            week_path=week_path,
            csv_path=csv_path,
            season=2026,
            week=2,
        )

    assert csv_path.exists()


@pytest.mark.unit
def test_non_pick_count() -> None:
    """Missing game picks are counted across imported players."""
    games = import_picks._games_from_week_data(_week_data())

    players = [
        Player(
            id="abigail",
            name="Abigail",
            nickname=None,
            picks={
                "game-1": "SEA",
                "game-2": "BUF",
            },
            tiebreaker=47.0,
        ),
        Player(
            id="kevin",
            name="Kevin",
            nickname=None,
            picks={
                "game-2": "MIA",
            },
            tiebreaker=42.0,
        ),
    ]

    assert (
        import_picks._count_non_picks(
            players=players,
            games=games,
        )
        == 1
    )
