"""Unit tests for PBJ weekly scoring."""

from datetime import UTC, datetime

import pytest

from pbj.domain.game import Game, GameStatus, Team
from pbj.domain.player import Player
from pbj.scoring import score_week


def _game(
    game_id: str,
    away: str,
    home: str,
    away_score: int | None,
    home_score: int | None,
    status: GameStatus = GameStatus.FINAL,
    scheduled_time: datetime | None = None,
) -> Game:
    """Build a normalized game for scoring tests."""
    return Game(
        id=game_id,
        scheduled_time=scheduled_time
        or datetime(
            2026,
            9,
            13,
            17,
            0,
            tzinfo=UTC,
        ),
        away=Team(
            id=f"{away}-id",
            abbreviation=away,
            name=f"{away} Team",
        ),
        home=Team(
            id=f"{home}-id",
            abbreviation=home,
            name=f"{home} Team",
        ),
        status=status,
        away_score=away_score,
        home_score=home_score,
    )


def _player(
    player_id: str = "abigail",
    picks: dict[str, str] | None = None,
    tiebreaker: float = 45.0,
) -> Player:
    """Build a player for scoring tests."""
    return Player(
        id=player_id,
        name=player_id.title(),
        nickname=None,
        picks=picks or {},
        tiebreaker=tiebreaker,
    )


@pytest.mark.unit
def test_correct_pick_counts_as_win():
    """A correct pick counts as one win."""
    games = [
        _game(
            "game-1",
            "NE",
            "SEA",
            10,
            13,
        ),
    ]

    players = [
        _player(
            picks={
                "game-1": "SEA",
            }
        ),
    ]

    result = score_week(games, players)
    player = result.players[0]

    assert player.wins == 1
    assert player.losses == 0
    assert player.ties == 0
    assert player.missed_picks == 0
    assert player.accuracy == 1.0


@pytest.mark.unit
def test_incorrect_pick_counts_as_loss():
    """An incorrect pick counts as one loss."""
    games = [
        _game(
            "game-1",
            "NE",
            "SEA",
            10,
            13,
        ),
    ]

    players = [
        _player(
            picks={
                "game-1": "NE",
            }
        ),
    ]

    result = score_week(games, players)
    player = result.players[0]

    assert player.wins == 0
    assert player.losses == 1
    assert player.ties == 0
    assert player.missed_picks == 0
    assert player.accuracy == 0.0


@pytest.mark.unit
@pytest.mark.smoke
def test_final_nfl_tie_counts_as_tie():
    """A final NFL tie counts as a tie and contributes half to Win %."""
    games = [
        _game(
            "game-1",
            "NE",
            "SEA",
            20,
            20,
        ),
    ]

    players = [
        _player(
            picks={
                "game-1": "SEA",
            }
        ),
    ]

    result = score_week(games, players)
    player = result.players[0]

    assert player.wins == 0
    assert player.losses == 0
    assert player.ties == 1
    assert player.missed_picks == 0
    assert player.accuracy == 0.5


@pytest.mark.unit
def test_missing_pick_counts_as_loss():
    """A missing pick on a final game counts as a loss."""
    games = [
        _game(
            "game-1",
            "NE",
            "SEA",
            10,
            13,
        ),
    ]

    players = [
        _player(
            picks={},
        ),
    ]

    result = score_week(games, players)
    player = result.players[0]

    assert player.wins == 0
    assert player.losses == 1
    assert player.ties == 0
    assert player.missed_picks == 1
    assert player.accuracy == 0.0


@pytest.mark.unit
def test_missing_pick_on_nfl_tie_counts_as_loss():
    """A missing pick is a loss even when the NFL game ends in a tie."""
    games = [
        _game(
            "game-1",
            "NE",
            "SEA",
            20,
            20,
        ),
    ]

    players = [
        _player(
            picks={},
        ),
    ]

    result = score_week(games, players)
    player = result.players[0]

    assert player.wins == 0
    assert player.losses == 1
    assert player.ties == 0
    assert player.missed_picks == 1
    assert player.accuracy == 0.0


@pytest.mark.unit
@pytest.mark.smoke
def test_missing_pick_is_included_in_win_percentage():
    """Missing picks are losses and therefore reduce Win %."""
    games = [
        _game(
            "game-1",
            "NE",
            "SEA",
            10,
            13,
        ),
        _game(
            "game-2",
            "SF",
            "LAR",
            27,
            7,
        ),
    ]

    players = [
        _player(
            picks={
                "game-1": "SEA",
            }
        ),
    ]

    result = score_week(games, players)
    player = result.players[0]

    assert player.wins == 1
    assert player.losses == 1
    assert player.ties == 0
    assert player.missed_picks == 1
    assert player.accuracy == 0.5


@pytest.mark.unit
def test_scheduled_game_is_ignored():
    """Scheduled games do not affect scoring."""
    games = [
        _game(
            "game-1",
            "NE",
            "SEA",
            0,
            0,
            status=GameStatus.SCHEDULED,
        ),
    ]

    players = [
        _player(
            picks={
                "game-1": "SEA",
            }
        ),
    ]

    result = score_week(games, players)
    player = result.players[0]

    assert player.wins == 0
    assert player.losses == 0
    assert player.ties == 0
    assert player.missed_picks == 0
    assert player.accuracy is None


@pytest.mark.unit
def test_missing_pick_on_scheduled_game_is_ignored():
    """A missing pick is not scored until the game is final."""
    games = [
        _game(
            "game-1",
            "NE",
            "SEA",
            0,
            0,
            status=GameStatus.SCHEDULED,
        ),
    ]

    players = [
        _player(
            picks={},
        ),
    ]

    result = score_week(games, players)
    player = result.players[0]

    assert player.wins == 0
    assert player.losses == 0
    assert player.ties == 0
    assert player.missed_picks == 0
    assert player.accuracy is None


@pytest.mark.unit
def test_live_game_is_ignored():
    """Live games do not affect scoring."""
    games = [
        _game(
            "game-1",
            "NE",
            "SEA",
            10,
            7,
            status=GameStatus.LIVE,
        ),
    ]

    players = [
        _player(
            picks={
                "game-1": "NE",
            }
        ),
    ]

    result = score_week(games, players)
    player = result.players[0]

    assert player.wins == 0
    assert player.losses == 0
    assert player.ties == 0
    assert player.missed_picks == 0
    assert player.accuracy is None


@pytest.mark.unit
def test_missing_pick_on_live_game_is_ignored():
    """A missing pick on a live game is not scored until the game is final."""
    games = [
        _game(
            "game-1",
            "NE",
            "SEA",
            10,
            7,
            status=GameStatus.LIVE,
        ),
    ]

    players = [
        _player(
            picks={},
        ),
    ]

    result = score_week(games, players)
    player = result.players[0]

    assert player.wins == 0
    assert player.losses == 0
    assert player.ties == 0
    assert player.missed_picks == 0
    assert player.accuracy is None


@pytest.mark.unit
@pytest.mark.smoke
def test_partial_week_counts_only_final_games():
    """Incomplete weeks still expose current results from final games."""
    games = [
        _game(
            "game-1",
            "NE",
            "SEA",
            10,
            13,
        ),
        _game(
            "game-2",
            "SF",
            "LAR",
            0,
            0,
            status=GameStatus.SCHEDULED,
        ),
    ]

    players = [
        _player(
            picks={
                "game-1": "SEA",
                "game-2": "LAR",
            }
        ),
    ]

    result = score_week(games, players)
    player = result.players[0]

    assert player.wins == 1
    assert player.losses == 0
    assert player.ties == 0
    assert player.missed_picks == 0
    assert player.accuracy == 1.0


@pytest.mark.unit
def test_incomplete_week_has_no_winner():
    """No weekly winner is declared until every game is final."""
    games = [
        _game(
            "game-1",
            "NE",
            "SEA",
            10,
            13,
        ),
        _game(
            "game-2",
            "SF",
            "LAR",
            0,
            0,
            status=GameStatus.SCHEDULED,
        ),
    ]

    players = [
        _player(
            picks={
                "game-1": "SEA",
                "game-2": "LAR",
            }
        ),
    ]

    result = score_week(games, players)

    assert result.weekly_winners == ()
    assert result.players[0].weekly_rank is None
    assert result.players[0].weekly_winner is False


@pytest.mark.unit
def test_monday_game_is_detected_in_eastern_time():
    """Monday is determined using U.S. Eastern local time."""
    games = [
        _game(
            "game-1",
            "DEN",
            "KC",
            20,
            27,
            scheduled_time=datetime(
                2026,
                9,
                15,
                0,
                15,
                tzinfo=UTC,
            ),
        ),
    ]

    players = [
        _player(
            picks={
                "game-1": "KC",
            },
            tiebreaker=50,
        ),
    ]

    result = score_week(games, players)

    assert result.monday_total == 47
    assert result.players[0].tiebreaker_distance == 3.0


@pytest.mark.unit
def test_non_monday_game_does_not_contribute_to_monday_total():
    """Sunday games do not contribute to the Monday tiebreaker total."""
    games = [
        _game(
            "game-1",
            "DAL",
            "NYG",
            24,
            20,
            scheduled_time=datetime(
                2026,
                9,
                14,
                0,
                20,
                tzinfo=UTC,
            ),
        ),
    ]

    players = [
        _player(
            picks={
                "game-1": "DAL",
            },
            tiebreaker=44,
        ),
    ]

    result = score_week(games, players)

    assert result.monday_total is None
    assert result.players[0].tiebreaker_distance is None


@pytest.mark.unit
def test_multiple_monday_games_are_combined():
    """All Monday final scores contribute to one combined total."""
    games = [
        _game(
            "game-1",
            "DEN",
            "KC",
            20,
            27,
            scheduled_time=datetime(
                2026,
                9,
                15,
                0,
                15,
                tzinfo=UTC,
            ),
        ),
        _game(
            "game-2",
            "BUF",
            "NYJ",
            17,
            21,
            scheduled_time=datetime(
                2026,
                9,
                15,
                1,
                30,
                tzinfo=UTC,
            ),
        ),
    ]

    players = [
        _player(
            picks={
                "game-1": "KC",
                "game-2": "NYJ",
            },
            tiebreaker=80,
        ),
    ]

    result = score_week(games, players)

    assert result.monday_total == 85
    assert result.players[0].tiebreaker_distance == 5.0


@pytest.mark.unit
def test_monday_total_is_none_until_all_monday_games_are_final():
    """The Monday total remains unknown while any Monday game is incomplete."""
    games = [
        _game(
            "game-1",
            "DEN",
            "KC",
            20,
            27,
            scheduled_time=datetime(
                2026,
                9,
                15,
                0,
                15,
                tzinfo=UTC,
            ),
        ),
        _game(
            "game-2",
            "BUF",
            "NYJ",
            0,
            0,
            status=GameStatus.SCHEDULED,
            scheduled_time=datetime(
                2026,
                9,
                15,
                1,
                30,
                tzinfo=UTC,
            ),
        ),
    ]

    players = [
        _player(
            picks={
                "game-1": "KC",
                "game-2": "NYJ",
            },
            tiebreaker=80,
        ),
    ]

    result = score_week(games, players)

    assert result.monday_total is None
    assert result.players[0].tiebreaker_distance is None


@pytest.mark.unit
def test_tiebreaker_distance_uses_absolute_difference():
    """Tiebreaker distance is the absolute difference from Monday total."""
    games = [
        _game(
            "game-1",
            "DEN",
            "KC",
            20,
            27,
            scheduled_time=datetime(
                2026,
                9,
                15,
                0,
                15,
                tzinfo=UTC,
            ),
        ),
    ]

    players = [
        _player(
            picks={
                "game-1": "KC",
            },
            tiebreaker=40,
        ),
    ]

    result = score_week(games, players)

    assert result.players[0].tiebreaker_distance == 7.0


@pytest.mark.unit
def test_player_with_most_wins_is_weekly_winner():
    """The player with the most wins wins the completed week."""
    games = [
        _game(
            "game-1",
            "NE",
            "SEA",
            10,
            13,
        ),
        _game(
            "game-2",
            "SF",
            "LAR",
            27,
            7,
        ),
    ]

    players = [
        _player(
            player_id="abigail",
            picks={
                "game-1": "SEA",
                "game-2": "SF",
            },
        ),
        _player(
            player_id="bob",
            picks={
                "game-1": "NE",
                "game-2": "SF",
            },
        ),
    ]

    result = score_week(games, players)

    assert result.weekly_winners == ("abigail",)

    abigail = result.players[0]
    bob = result.players[1]

    assert abigail.player_id == "abigail"
    assert abigail.weekly_rank == 1
    assert abigail.weekly_winner is True

    assert bob.player_id == "bob"
    assert bob.weekly_rank == 2
    assert bob.weekly_winner is False


@pytest.mark.unit
@pytest.mark.smoke
def test_equal_wins_are_resolved_by_tiebreaker():
    """Monday tiebreaker distance resolves equal weekly win totals."""
    games = [
        _game(
            "game-1",
            "NE",
            "SEA",
            10,
            13,
        ),
        _game(
            "game-2",
            "DEN",
            "KC",
            20,
            27,
            scheduled_time=datetime(
                2026,
                9,
                15,
                0,
                15,
                tzinfo=UTC,
            ),
        ),
    ]

    players = [
        _player(
            player_id="abigail",
            picks={
                "game-1": "SEA",
                "game-2": "DEN",
            },
            tiebreaker=46,
        ),
        _player(
            player_id="bob",
            picks={
                "game-1": "NE",
                "game-2": "KC",
            },
            tiebreaker=55,
        ),
    ]

    result = score_week(games, players)

    assert result.weekly_winners == ("abigail",)

    abigail = result.players[0]
    bob = result.players[1]

    assert abigail.wins == 1
    assert bob.wins == 1

    assert abigail.tiebreaker_distance == 1.0
    assert bob.tiebreaker_distance == 8.0

    assert abigail.weekly_rank == 1
    assert bob.weekly_rank == 2


@pytest.mark.unit
def test_exact_tiebreaker_tie_produces_split_winners():
    """Players tied in wins and tiebreaker distance split the week."""
    games = [
        _game(
            "game-1",
            "NE",
            "SEA",
            10,
            13,
        ),
        _game(
            "game-2",
            "DEN",
            "KC",
            20,
            27,
            scheduled_time=datetime(
                2026,
                9,
                15,
                0,
                15,
                tzinfo=UTC,
            ),
        ),
    ]

    players = [
        _player(
            player_id="abigail",
            picks={
                "game-1": "SEA",
                "game-2": "DEN",
            },
            tiebreaker=45,
        ),
        _player(
            player_id="bob",
            picks={
                "game-1": "NE",
                "game-2": "KC",
            },
            tiebreaker=49,
        ),
    ]

    result = score_week(games, players)

    assert result.monday_total == 47
    assert result.weekly_winners == (
        "abigail",
        "bob",
    )

    assert result.players[0].weekly_rank == 1
    assert result.players[0].weekly_winner is True

    assert result.players[1].weekly_rank == 1
    assert result.players[1].weekly_winner is True


@pytest.mark.unit
def test_tied_players_receive_same_rank():
    """Equivalent ranking keys receive the same weekly rank."""
    games = [
        _game(
            "game-1",
            "DEN",
            "KC",
            20,
            27,
            scheduled_time=datetime(
                2026,
                9,
                15,
                0,
                15,
                tzinfo=UTC,
            ),
        ),
    ]

    players = [
        _player(
            player_id="abigail",
            picks={
                "game-1": "KC",
            },
            tiebreaker=45,
        ),
        _player(
            player_id="bob",
            picks={
                "game-1": "KC",
            },
            tiebreaker=49,
        ),
        _player(
            player_id="charlie",
            picks={
                "game-1": "DEN",
            },
            tiebreaker=47,
        ),
    ]

    result = score_week(games, players)

    assert result.players[0].weekly_rank == 1
    assert result.players[1].weekly_rank == 1
    assert result.players[2].weekly_rank == 3


@pytest.mark.unit
def test_tied_players_use_tournament_ranking():
    """Ranks skip positions after a tie."""
    games = [
        _game(
            "game-1",
            "DEN",
            "KC",
            20,
            27,
            scheduled_time=datetime(
                2026,
                9,
                15,
                0,
                15,
                tzinfo=UTC,
            ),
        ),
        _game(
            "game-2",
            "NE",
            "SEA",
            10,
            13,
        ),
    ]

    players = [
        _player(
            player_id="alpha",
            picks={
                "game-1": "KC",
                "game-2": "SEA",
            },
            tiebreaker=47,
        ),
        _player(
            player_id="bravo",
            picks={
                "game-1": "KC",
                "game-2": "NE",
            },
            tiebreaker=45,
        ),
        _player(
            player_id="charlie",
            picks={
                "game-1": "DEN",
                "game-2": "SEA",
            },
            tiebreaker=49,
        ),
        _player(
            player_id="delta",
            picks={
                "game-1": "DEN",
                "game-2": "NE",
            },
            tiebreaker=47,
        ),
    ]

    result = score_week(games, players)

    assert [player.weekly_rank for player in result.players] == [1, 2, 2, 4]


@pytest.mark.unit
def test_player_count_matches_number_of_players():
    """Week result records the number of participating players."""
    games = [
        _game(
            "game-1",
            "NE",
            "SEA",
            10,
            13,
        ),
    ]

    players = [
        _player(
            player_id="abigail",
            picks={
                "game-1": "SEA",
            },
        ),
        _player(
            player_id="bob",
            picks={
                "game-1": "NE",
            },
        ),
    ]

    result = score_week(games, players)

    assert result.player_count == 2


@pytest.mark.unit
def test_final_game_missing_score_raises_error():
    """A final game must contain both scores."""
    games = [
        _game(
            "game-1",
            "NE",
            "SEA",
            None,
            13,
        ),
    ]

    players = [
        _player(
            picks={
                "game-1": "SEA",
            }
        ),
    ]

    with pytest.raises(
        ValueError,
        match="final game game-1 is missing a score",
    ):
        score_week(games, players)


@pytest.mark.unit
def test_final_monday_game_missing_score_raises_error():
    """A final Monday game must contain both scores."""
    games = [
        _game(
            "game-1",
            "DEN",
            "KC",
            None,
            27,
            scheduled_time=datetime(
                2026,
                9,
                15,
                0,
                15,
                tzinfo=UTC,
            ),
        ),
    ]

    players = [
        _player(
            picks={
                "game-1": "KC",
            }
        ),
    ]

    with pytest.raises(
        ValueError,
        match="final Monday game game-1 is missing a score",
    ):
        score_week(games, players)


@pytest.mark.unit
def test_empty_game_list_is_not_completed_week():
    """An empty schedule cannot produce a weekly winner."""
    players = [
        _player(),
    ]

    result = score_week([], players)

    assert result.monday_total is None
    assert result.weekly_winners == ()
    assert result.players[0].weekly_rank is None
    assert result.players[0].weekly_winner is False
