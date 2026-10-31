"""Tests for active football week selection."""

from datetime import UTC, datetime

import pytest

from pbj.active_week import select_active_week
from pbj.domain.game import Game, GameStatus, Team


def _game(status: GameStatus) -> Game:
    return Game(
        id="game-1",
        scheduled_time=datetime(
            2026,
            9,
            20,
            17,
            0,
            tzinfo=UTC,
        ),
        away=Team(
            id="1",
            abbreviation="NE",
            name="New England Patriots",
        ),
        home=Team(
            id="2",
            abbreviation="SEA",
            name="Seattle Seahawks",
        ),
        status=status,
        away_score=None,
        home_score=None,
    )


@pytest.mark.unit
@pytest.mark.smoke
def test_selects_unfinished_week_before_future_week() -> None:
    weeks = {
        1: [_game(GameStatus.FINAL)],
        2: [_game(GameStatus.SCHEDULED)],
        3: [_game(GameStatus.SCHEDULED)],
    }

    assert select_active_week(weeks) == 2


@pytest.mark.unit
def test_returns_none_when_all_weeks_are_final() -> None:
    weeks = {
        1: [_game(GameStatus.FINAL)],
        2: [_game(GameStatus.FINAL)],
    }

    assert select_active_week(weeks) is None


@pytest.mark.unit
def test_returns_none_when_no_weeks_exist() -> None:
    assert select_active_week({}) is None
