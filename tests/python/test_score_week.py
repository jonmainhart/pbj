"""Tests for the weekly scoring script."""

import json
from pathlib import Path
from typing import Any

import pytest

from scripts.score_week import score_week_file


def _week_data() -> dict[str, Any]:
    """Build a complete weekly document for script tests."""
    return {
        "season": 2026,
        "week": 1,
        "lock_time": "2026-09-09T23:20:00+00:00",
        "games": [
            {
                "id": "game-1",
                "scheduled_time": ("2026-09-13T17:00:00+00:00"),
                "away": {
                    "id": "NE-id",
                    "abbreviation": "NE",
                    "name": "New England Patriots",
                },
                "home": {
                    "id": "SEA-id",
                    "abbreviation": "SEA",
                    "name": "Seattle Seahawks",
                },
                "status": "final",
                "away_score": 10,
                "home_score": 13,
            },
            {
                "id": "game-2",
                "scheduled_time": ("2026-09-15T00:15:00+00:00"),
                "away": {
                    "id": "DEN-id",
                    "abbreviation": "DEN",
                    "name": "Denver Broncos",
                },
                "home": {
                    "id": "KC-id",
                    "abbreviation": "KC",
                    "name": "Kansas City Chiefs",
                },
                "status": "final",
                "away_score": 20,
                "home_score": 27,
            },
        ],
        "players": [
            {
                "id": "abigail",
                "name": "Abigail",
                "nickname": None,
                "picks": {
                    "game-1": "SEA",
                    "game-2": "KC",
                },
                "tiebreaker": 46.0,
            },
            {
                "id": "bob",
                "name": "Bob",
                "nickname": None,
                "picks": {
                    "game-1": "NE",
                    "game-2": "KC",
                },
                "tiebreaker": 47.0,
            },
        ],
    }


def _write_week(
    path: Path,
    data: dict[str, Any],
) -> None:
    """Write test weekly JSON."""
    path.write_text(
        json.dumps(data),
        encoding="utf-8",
    )


def _read_week(
    path: Path,
) -> dict[str, Any]:
    """Read test weekly JSON."""
    data = json.loads(
        path.read_text(
            encoding="utf-8",
        )
    )

    assert isinstance(data, dict)

    return data


@pytest.mark.unit
@pytest.mark.smoke
def test_score_week_writes_results(
    tmp_path: Path,
):
    """Scoring writes derived weekly results."""
    path = tmp_path / "week01.json"

    _write_week(
        path,
        _week_data(),
    )

    score_week_file(
        path=path,
        season=2026,
        week=1,
    )

    data = _read_week(path)
    results = data["results"]

    assert results["player_count"] == 2
    assert results["monday_total"] == 47
    assert results["weekly_winners"] == ["abigail"]


@pytest.mark.unit
def test_score_week_writes_player_results(
    tmp_path: Path,
):
    """Scoring writes normalized per-player result fields."""
    path = tmp_path / "week01.json"

    _write_week(
        path,
        _week_data(),
    )

    score_week_file(
        path=path,
        season=2026,
        week=1,
    )

    data = _read_week(path)

    players = {player["player_id"]: player for player in data["results"]["players"]}

    abigail = players["abigail"]

    assert abigail["wins"] == 2
    assert abigail["losses"] == 0
    assert abigail["ties"] == 0
    assert abigail["missed_picks"] == 0
    assert abigail["accuracy"] == 1.0
    assert abigail["tiebreaker_distance"] == 1.0
    assert abigail["weekly_rank"] == 1
    assert abigail["weekly_winner"] is True


@pytest.mark.unit
def test_score_week_writes_missed_pick_as_loss(
    tmp_path: Path,
):
    """A final-game non-pick is written as a loss and missed pick."""
    path = tmp_path / "week01.json"
    week = _week_data()

    bob = week["players"][1]
    del bob["picks"]["game-1"]

    _write_week(
        path,
        week,
    )

    score_week_file(
        path=path,
        season=2026,
        week=1,
    )

    data = _read_week(path)

    players = {player["player_id"]: player for player in data["results"]["players"]}

    bob_result = players["bob"]

    assert bob_result["wins"] == 1
    assert bob_result["losses"] == 1
    assert bob_result["ties"] == 0
    assert bob_result["missed_picks"] == 1
    assert bob_result["accuracy"] == 0.5


@pytest.mark.unit
def test_score_week_preserves_games(
    tmp_path: Path,
):
    """Scoring does not modify canonical game data."""
    path = tmp_path / "week01.json"
    original = _week_data()
    original_games = original["games"]

    _write_week(
        path,
        original,
    )

    score_week_file(
        path=path,
        season=2026,
        week=1,
    )

    data = _read_week(path)

    assert data["games"] == original_games


@pytest.mark.unit
def test_score_week_preserves_players(
    tmp_path: Path,
):
    """Scoring does not modify commissioner pick data."""
    path = tmp_path / "week01.json"
    original = _week_data()
    original_players = original["players"]

    _write_week(
        path,
        original,
    )

    score_week_file(
        path=path,
        season=2026,
        week=1,
    )

    data = _read_week(path)

    assert data["players"] == original_players


@pytest.mark.unit
def test_score_week_preserves_lock_time(
    tmp_path: Path,
):
    """Scoring preserves shared weekly metadata."""
    path = tmp_path / "week01.json"

    _write_week(
        path,
        _week_data(),
    )

    score_week_file(
        path=path,
        season=2026,
        week=1,
    )

    data = _read_week(path)

    assert data["lock_time"] == "2026-09-09T23:20:00+00:00"


@pytest.mark.unit
def test_score_week_replaces_existing_results(
    tmp_path: Path,
):
    """Rerunning scoring replaces stale derived results."""
    path = tmp_path / "week01.json"
    week = _week_data()

    week["results"] = {
        "stale": True,
    }

    _write_week(
        path,
        week,
    )

    score_week_file(
        path=path,
        season=2026,
        week=1,
    )

    data = _read_week(path)

    assert "stale" not in data["results"]
    assert data["results"]["player_count"] == 2


@pytest.mark.unit
def test_score_week_is_safe_to_rerun(
    tmp_path: Path,
):
    """Repeated scoring produces identical weekly data."""
    path = tmp_path / "week01.json"

    _write_week(
        path,
        _week_data(),
    )

    score_week_file(
        path=path,
        season=2026,
        week=1,
    )

    first = _read_week(path)

    score_week_file(
        path=path,
        season=2026,
        week=1,
    )

    second = _read_week(path)

    assert second == first


@pytest.mark.unit
def test_score_week_rejects_wrong_season(
    tmp_path: Path,
):
    """Requested season must match the weekly file."""
    path = tmp_path / "week01.json"

    _write_week(
        path,
        _week_data(),
    )

    with pytest.raises(
        ValueError,
        match="contains season 2026, expected 2025",
    ):
        score_week_file(
            path=path,
            season=2025,
            week=1,
        )


@pytest.mark.unit
def test_score_week_rejects_wrong_week(
    tmp_path: Path,
):
    """Requested week must match the weekly file."""
    path = tmp_path / "week01.json"

    _write_week(
        path,
        _week_data(),
    )

    with pytest.raises(
        ValueError,
        match="contains week 1, expected 2",
    ):
        score_week_file(
            path=path,
            season=2026,
            week=2,
        )


@pytest.mark.unit
def test_score_week_requires_games(
    tmp_path: Path,
):
    """A weekly file must contain games before scoring."""
    path = tmp_path / "week01.json"
    week = _week_data()
    week["games"] = []

    _write_week(
        path,
        week,
    )

    with pytest.raises(
        ValueError,
        match="does not contain game data",
    ):
        score_week_file(
            path=path,
            season=2026,
            week=1,
        )


@pytest.mark.unit
def test_score_week_requires_players(
    tmp_path: Path,
):
    """A weekly file must contain players before scoring."""
    path = tmp_path / "week01.json"
    week = _week_data()
    week["players"] = []

    _write_week(
        path,
        week,
    )

    with pytest.raises(
        ValueError,
        match="does not contain player data",
    ):
        score_week_file(
            path=path,
            season=2026,
            week=1,
        )
