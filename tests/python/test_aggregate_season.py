"""Tests for the season aggregation script."""

import json
from pathlib import Path
from typing import Any

import pytest

from scripts.aggregate_season import aggregate_season_files


def _week_data(
    week: int,
    *,
    complete: bool = True,
    winner: str = "abigail",
) -> dict[str, Any]:
    """Build weekly JSON for aggregation script tests."""
    weekly_winners = [winner] if complete else []

    weekly_rank = 1 if complete else None

    return {
        "season": 2026,
        "week": week,
        "results": {
            "monday_total": (47 if complete else None),
            "player_count": 2,
            "weekly_winners": weekly_winners,
            "players": [
                {
                    "player_id": "abigail",
                    "wins": 12,
                    "losses": 4,
                    "ties": 0,
                    "missed_picks": 1,
                    "accuracy": 0.75,
                    "tiebreaker_distance": (2.0 if complete else None),
                    "weekly_rank": weekly_rank,
                    "weekly_winner": (complete and winner == "abigail"),
                },
                {
                    "player_id": "bob",
                    "wins": 10,
                    "losses": 6,
                    "ties": 0,
                    "missed_picks": 2,
                    "accuracy": 0.625,
                    "tiebreaker_distance": (5.0 if complete else None),
                    "weekly_rank": (2 if complete else None),
                    "weekly_winner": (complete and winner == "bob"),
                },
            ],
        },
    }


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


@pytest.mark.unit
def test_aggregate_season_writes_season_json(
    tmp_path: Path,
):
    """Completed weeks are written to season.json."""
    season_dir = tmp_path / "2026"
    season_dir.mkdir()

    _write_json(
        season_dir / "week01.json",
        _week_data(1),
    )

    aggregate_season_files(
        season=2026,
        season_dir=season_dir,
    )

    data = _read_json(season_dir / "season.json")

    assert data["season"] == 2026
    assert data["weeks_scored"] == [1]
    assert len(data["players"]) == 2

    players = {player["player_id"]: player for player in data["players"]}

    assert players["abigail"]["missed_picks"] == 1
    assert players["bob"]["missed_picks"] == 2


@pytest.mark.unit
def test_incomplete_week_is_ignored(
    tmp_path: Path,
):
    """Incomplete weekly results do not enter season.json."""
    season_dir = tmp_path / "2026"
    season_dir.mkdir()

    _write_json(
        season_dir / "week01.json",
        _week_data(
            1,
            complete=False,
        ),
    )

    aggregate_season_files(
        season=2026,
        season_dir=season_dir,
    )

    data = _read_json(season_dir / "season.json")

    assert data["weeks_scored"] == []
    assert data["players"] == []


@pytest.mark.unit
def test_week_without_results_is_ignored(
    tmp_path: Path,
):
    """Unscored weekly files are skipped."""
    season_dir = tmp_path / "2026"
    season_dir.mkdir()

    _write_json(
        season_dir / "week01.json",
        {
            "season": 2026,
            "week": 1,
            "games": [],
            "players": [],
        },
    )

    aggregate_season_files(
        season=2026,
        season_dir=season_dir,
    )

    data = _read_json(season_dir / "season.json")

    assert data["weeks_scored"] == []
    assert data["players"] == []


@pytest.mark.unit
@pytest.mark.smoke
def test_multiple_completed_weeks_are_aggregated(
    tmp_path: Path,
):
    """Completed weekly results accumulate across the season."""
    season_dir = tmp_path / "2026"
    season_dir.mkdir()

    _write_json(
        season_dir / "week01.json",
        _week_data(
            1,
            winner="abigail",
        ),
    )

    _write_json(
        season_dir / "week02.json",
        _week_data(
            2,
            winner="bob",
        ),
    )

    aggregate_season_files(
        season=2026,
        season_dir=season_dir,
    )

    data = _read_json(season_dir / "season.json")

    assert data["weeks_scored"] == [
        1,
        2,
    ]

    players = {player["player_id"]: player for player in data["players"]}

    assert players["abigail"]["weeks_played"] == 2
    assert players["abigail"]["wins"] == 24
    assert players["abigail"]["losses"] == 8
    assert players["abigail"]["missed_picks"] == 2
    assert players["abigail"]["weekly_wins"] == 1

    assert players["bob"]["weeks_played"] == 2
    assert players["bob"]["wins"] == 20
    assert players["bob"]["losses"] == 12
    assert players["bob"]["missed_picks"] == 4
    assert players["bob"]["weekly_wins"] == 1


@pytest.mark.unit
def test_missed_picks_remain_part_of_losses(
    tmp_path: Path,
):
    """Missed picks are tracked separately but remain included in losses."""
    season_dir = tmp_path / "2026"
    season_dir.mkdir()

    week = _week_data(1)

    week["results"]["players"][0]["wins"] = 10
    week["results"]["players"][0]["losses"] = 6
    week["results"]["players"][0]["missed_picks"] = 2
    week["results"]["players"][0]["accuracy"] = 0.625

    _write_json(
        season_dir / "week01.json",
        week,
    )

    aggregate_season_files(
        season=2026,
        season_dir=season_dir,
    )

    data = _read_json(season_dir / "season.json")

    players = {player["player_id"]: player for player in data["players"]}

    abigail = players["abigail"]

    assert abigail["wins"] == 10
    assert abigail["losses"] == 6
    assert abigail["missed_picks"] == 2
    assert abigail["accuracy"] == pytest.approx(10 / 16)


@pytest.mark.unit
def test_existing_season_json_is_rebuilt(
    tmp_path: Path,
):
    """Existing aggregate data is replaced rather than incremented."""
    season_dir = tmp_path / "2026"
    season_dir.mkdir()

    _write_json(
        season_dir / "week01.json",
        _week_data(1),
    )

    _write_json(
        season_dir / "season.json",
        {
            "season": 2026,
            "weeks_scored": [
                99,
            ],
            "players": [
                {
                    "player_id": "stale",
                },
            ],
        },
    )

    aggregate_season_files(
        season=2026,
        season_dir=season_dir,
    )

    data = _read_json(season_dir / "season.json")

    assert data["weeks_scored"] == [1]

    player_ids = {player["player_id"] for player in data["players"]}

    assert "stale" not in player_ids


@pytest.mark.unit
def test_aggregation_is_safe_to_rerun(
    tmp_path: Path,
):
    """Repeated aggregation produces identical season data."""
    season_dir = tmp_path / "2026"
    season_dir.mkdir()

    _write_json(
        season_dir / "week01.json",
        _week_data(1),
    )

    aggregate_season_files(
        season=2026,
        season_dir=season_dir,
    )

    first = _read_json(season_dir / "season.json")

    aggregate_season_files(
        season=2026,
        season_dir=season_dir,
    )

    second = _read_json(season_dir / "season.json")

    assert second == first


@pytest.mark.unit
def test_wrong_season_in_week_file_raises_error(
    tmp_path: Path,
):
    """Weekly file season must match requested season."""
    season_dir = tmp_path / "2026"
    season_dir.mkdir()

    week = _week_data(1)
    week["season"] = 2025

    _write_json(
        season_dir / "week01.json",
        week,
    )

    with pytest.raises(
        ValueError,
        match="contains season 2025, expected 2026",
    ):
        aggregate_season_files(
            season=2026,
            season_dir=season_dir,
        )


@pytest.mark.unit
def test_wrong_week_in_week_file_raises_error(
    tmp_path: Path,
):
    """Weekly filename and stored week must agree."""
    season_dir = tmp_path / "2026"
    season_dir.mkdir()

    week = _week_data(2)

    _write_json(
        season_dir / "week01.json",
        week,
    )

    with pytest.raises(
        ValueError,
        match="contains week 2, expected 1",
    ):
        aggregate_season_files(
            season=2026,
            season_dir=season_dir,
        )


@pytest.mark.unit
def test_missing_season_directory_creates_empty_season(
    tmp_path: Path,
):
    """A season with no weekly files produces an empty aggregate."""
    season_dir = tmp_path / "2026"

    aggregate_season_files(
        season=2026,
        season_dir=season_dir,
    )

    data = _read_json(season_dir / "season.json")

    assert data == {
        "season": 2026,
        "weeks_scored": [],
        "players": [],
    }


@pytest.mark.unit
def test_last_place_finishes_are_written_to_season_json(
    tmp_path: Path,
):
    """Last-place finishes are included in season.json."""
    season_dir = tmp_path / "2026"
    season_dir.mkdir()

    _write_json(
        season_dir / "week01.json",
        _week_data(1),
    )

    aggregate_season_files(
        season=2026,
        season_dir=season_dir,
    )

    data = _read_json(season_dir / "season.json")

    players = {player["player_id"]: player for player in data["players"]}

    assert players["abigail"]["last_place_finishes"] == 0
    assert players["bob"]["last_place_finishes"] == 1
