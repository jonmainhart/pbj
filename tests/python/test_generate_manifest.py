"""Tests for the available-week manifest generator."""

from pathlib import Path

import pytest

from scripts.generate_manifest import build_manifest


@pytest.mark.unit
def test_build_manifest_discovers_available_weeks(
    tmp_path: Path,
) -> None:
    data_dir = tmp_path / "data"
    season_dir = data_dir / "2026"
    season_dir.mkdir(parents=True)

    for week in (1, 2, 3):
        (season_dir / f"week{week:02d}.json").touch()

    manifest = build_manifest(data_dir)

    assert manifest == {
        "2026": [1, 2, 3],
    }


@pytest.mark.unit
def test_build_manifest_sorts_weeks_numerically(
    tmp_path: Path,
) -> None:
    data_dir = tmp_path / "data"
    season_dir = data_dir / "2026"
    season_dir.mkdir(parents=True)

    for week in (10, 2, 1):
        (season_dir / f"week{week:02d}.json").touch()

    manifest = build_manifest(data_dir)

    assert manifest == {
        "2026": [1, 2, 10],
    }


@pytest.mark.unit
def test_build_manifest_ignores_directories_without_weeks(
    tmp_path: Path,
) -> None:
    data_dir = tmp_path / "data"
    (data_dir / "2026").mkdir(parents=True)
    (data_dir / "raw").mkdir()

    manifest = build_manifest(data_dir)

    assert manifest == {}
