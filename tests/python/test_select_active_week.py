"""Tests for active-week selection script."""

import json
from pathlib import Path
from typing import Any

import pytest

from pbj.active_week import select_active_week
from scripts.select_active_week import _load_weeks


def _week_data(
    week: int,
    status: str,
) -> dict[str, Any]:
    return {
        "season": 2026,
        "week": week,
        "games": [
            {
                "id": f"game-{week}",
                "scheduled_time": "2026-09-20T17:00:00+00:00",
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
                "status": status,
                "away_score": None,
                "home_score": None,
            },
        ],
    }


@pytest.mark.unit
def test_load_weeks_discovers_weekly_data(
    tmp_path: Path,
) -> None:
    season_dir = tmp_path / "2026"
    season_dir.mkdir()

    for week in (1, 2, 3):
        path = season_dir / f"week{week:02d}.json"
        path.write_text(
            json.dumps({"games": []}),
            encoding="utf-8",
        )

    weeks = _load_weeks(season_dir)

    assert set(weeks) == {1, 2, 3}


@pytest.mark.unit
def test_selects_unfinished_week_before_future_week(
    tmp_path: Path,
) -> None:
    season_dir = tmp_path / "2026"
    season_dir.mkdir()

    statuses = {
        1: "final",
        2: "scheduled",
        3: "scheduled",
    }

    for week, status in statuses.items():
        path = season_dir / f"week{week:02d}.json"
        path.write_text(
            json.dumps(_week_data(week, status)),
            encoding="utf-8",
        )

    weeks = _load_weeks(season_dir)

    assert select_active_week(weeks) == 2
