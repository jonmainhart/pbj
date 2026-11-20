"""Tests for NFL polling decisions."""

from datetime import UTC, datetime, timedelta

import pytest

from pbj.domain.game import Game, GameStatus, Team
from pbj.polling import should_poll


def _game(
    *,
    scheduled_time: datetime,
    status: GameStatus = GameStatus.SCHEDULED,
) -> Game:
    return Game(
        id="game-1",
        scheduled_time=scheduled_time,
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
def test_poll_fifteen_minutes_before_kickoff() -> None:
    now = datetime(
        2026,
        9,
        13,
        17,
        0,
        tzinfo=UTC,
    )

    game = _game(
        scheduled_time=now + timedelta(minutes=15),
    )

    assert should_poll([game], now)


@pytest.mark.unit
def test_does_not_poll_too_early() -> None:
    now = datetime(
        2026,
        9,
        13,
        17,
        0,
        tzinfo=UTC,
    )

    game = _game(
        scheduled_time=now + timedelta(minutes=16),
    )

    assert not should_poll([game], now)


@pytest.mark.unit
def test_poll_during_expected_game_window() -> None:
    now = datetime(
        2026,
        9,
        13,
        20,
        0,
        tzinfo=UTC,
    )

    game = _game(
        scheduled_time=now - timedelta(hours=3),
    )

    assert should_poll([game], now)


@pytest.mark.unit
def test_scheduled_game_stops_after_six_hours() -> None:
    now = datetime(
        2026,
        9,
        14,
        0,
        1,
        tzinfo=UTC,
    )

    game = _game(
        scheduled_time=now
        - timedelta(
            hours=6,
            minutes=1,
        ),
    )

    assert not should_poll([game], now)


@pytest.mark.unit
@pytest.mark.smoke
def test_live_game_always_polls() -> None:
    now = datetime(
        2026,
        9,
        14,
        3,
        0,
        tzinfo=UTC,
    )

    game = _game(
        scheduled_time=now - timedelta(hours=8),
        status=GameStatus.LIVE,
    )

    assert should_poll([game], now)


@pytest.mark.unit
def test_final_game_does_not_poll() -> None:
    now = datetime(
        2026,
        9,
        13,
        20,
        0,
        tzinfo=UTC,
    )

    game = _game(
        scheduled_time=now - timedelta(hours=3),
        status=GameStatus.FINAL,
    )

    assert not should_poll([game], now)


@pytest.mark.unit
def test_any_relevant_game_enables_polling() -> None:
    now = datetime(
        2026,
        9,
        13,
        20,
        0,
        tzinfo=UTC,
    )

    final_game = _game(
        scheduled_time=now - timedelta(hours=3),
        status=GameStatus.FINAL,
    )

    scheduled_game = _game(
        scheduled_time=now + timedelta(minutes=10),
    )

    assert should_poll(
        [
            final_game,
            scheduled_game,
        ],
        now,
    )


@pytest.mark.unit
def test_no_games_does_not_poll() -> None:
    now = datetime(
        2026,
        9,
        13,
        20,
        0,
        tzinfo=UTC,
    )

    assert not should_poll([], now)


@pytest.mark.unit
def test_naive_now_is_rejected() -> None:
    now = datetime(
        2026,
        9,
        13,
        20,
        0,
    )

    game = _game(
        scheduled_time=datetime(
            2026,
            9,
            13,
            20,
            0,
            tzinfo=UTC,
        )
    )

    with pytest.raises(
        ValueError,
        match="timezone-aware",
    ):
        should_poll([game], now)
