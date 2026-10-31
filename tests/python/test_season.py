"""Unit tests for PBJ season aggregation."""

import pytest

from pbj.scoring import PlayerResult, WeekResult
from pbj.season import aggregate_season


def _player_result(
    player_id: str,
    wins: int = 0,
    losses: int = 0,
    ties: int = 0,
    missed_picks: int = 0,
    weekly_rank: int | None = 1,
    weekly_winner: bool = False,
) -> PlayerResult:
    """Build a weekly player result for aggregation tests."""
    denominator = wins + losses + ties

    accuracy = (wins + (0.5 * ties)) / denominator if denominator else None

    return PlayerResult(
        player_id=player_id,
        wins=wins,
        losses=losses,
        ties=ties,
        missed_picks=missed_picks,
        accuracy=accuracy,
        tiebreaker_distance=0.0,
        weekly_rank=weekly_rank,
        weekly_winner=weekly_winner,
    )


def _week_result(
    players: tuple[PlayerResult, ...],
    weekly_winners: tuple[str, ...],
) -> WeekResult:
    """Build weekly results for aggregation tests."""
    return WeekResult(
        monday_total=47,
        player_count=len(players),
        weekly_winners=weekly_winners,
        players=players,
    )


@pytest.mark.unit
def test_completed_week_is_aggregated():
    """Completed weekly results contribute to season totals."""
    week = _week_result(
        players=(
            _player_result(
                "abigail",
                wins=12,
                losses=4,
                missed_picks=1,
                weekly_winner=True,
            ),
        ),
        weekly_winners=("abigail",),
    )

    result = aggregate_season(
        season=2026,
        weeks=[
            (1, week),
        ],
    )

    assert result.season == 2026
    assert result.weeks_scored == (1,)

    player = result.players[0]

    assert player.player_id == "abigail"
    assert player.weeks_played == 1
    assert player.wins == 12
    assert player.losses == 4
    assert player.ties == 0
    assert player.missed_picks == 1
    assert player.accuracy == 0.75
    assert player.weekly_wins == 1


@pytest.mark.unit
def test_incomplete_week_is_ignored():
    """Incomplete weekly results do not affect season statistics."""
    week = _week_result(
        players=(
            _player_result(
                "abigail",
                wins=1,
                losses=1,
                missed_picks=1,
                weekly_rank=None,
            ),
        ),
        weekly_winners=(),
    )

    result = aggregate_season(
        season=2026,
        weeks=[
            (1, week),
        ],
    )

    assert result.weeks_scored == ()
    assert result.players == ()


@pytest.mark.unit
def test_multiple_weeks_are_accumulated():
    """Statistics accumulate across completed weeks."""
    week_one = _week_result(
        players=(
            _player_result(
                "abigail",
                wins=12,
                losses=4,
                missed_picks=1,
                weekly_winner=True,
            ),
        ),
        weekly_winners=("abigail",),
    )

    week_two = _week_result(
        players=(
            _player_result(
                "abigail",
                wins=10,
                losses=6,
                missed_picks=2,
            ),
        ),
        weekly_winners=("bob",),
    )

    result = aggregate_season(
        season=2026,
        weeks=[
            (1, week_one),
            (2, week_two),
        ],
    )

    player = result.players[0]

    assert result.weeks_scored == (
        1,
        2,
    )

    assert player.weeks_played == 2
    assert player.wins == 22
    assert player.losses == 10
    assert player.missed_picks == 3
    assert player.weekly_wins == 1


@pytest.mark.unit
def test_missed_picks_are_accumulated():
    """Missed picks accumulate across completed weeks."""
    week_one = _week_result(
        players=(
            _player_result(
                "abigail",
                wins=10,
                losses=6,
                missed_picks=1,
                weekly_winner=True,
            ),
        ),
        weekly_winners=("abigail",),
    )

    week_two = _week_result(
        players=(
            _player_result(
                "abigail",
                wins=8,
                losses=8,
                missed_picks=3,
            ),
        ),
        weekly_winners=("bob",),
    )

    result = aggregate_season(
        season=2026,
        weeks=[
            (1, week_one),
            (2, week_two),
        ],
    )

    player = result.players[0]

    assert player.losses == 14
    assert player.missed_picks == 4


@pytest.mark.unit
def test_win_percentage_uses_cumulative_totals():
    """Season Win % is calculated from cumulative W-L-T totals."""
    week_one = _week_result(
        players=(
            _player_result(
                "abigail",
                wins=1,
                losses=0,
                weekly_winner=True,
            ),
        ),
        weekly_winners=("abigail",),
    )

    week_two = _week_result(
        players=(
            _player_result(
                "abigail",
                wins=1,
                losses=3,
                missed_picks=1,
            ),
        ),
        weekly_winners=("bob",),
    )

    result = aggregate_season(
        season=2026,
        weeks=[
            (1, week_one),
            (2, week_two),
        ],
    )

    player = result.players[0]

    assert player.wins == 2
    assert player.losses == 3
    assert player.missed_picks == 1
    assert player.accuracy == pytest.approx(0.4)


@pytest.mark.unit
def test_missed_pick_losses_reduce_season_win_percentage():
    """Losses caused by missed picks reduce season Win %."""
    week = _week_result(
        players=(
            _player_result(
                "abigail",
                wins=1,
                losses=1,
                missed_picks=1,
                weekly_winner=True,
            ),
        ),
        weekly_winners=("abigail",),
    )

    result = aggregate_season(
        season=2026,
        weeks=[
            (1, week),
        ],
    )

    player = result.players[0]

    assert player.wins == 1
    assert player.losses == 1
    assert player.missed_picks == 1
    assert player.accuracy == 0.5


@pytest.mark.unit
def test_ties_are_accumulated():
    """NFL ties accumulate and contribute half to season Win %."""
    week_one = _week_result(
        players=(
            _player_result(
                "abigail",
                wins=8,
                losses=7,
                ties=1,
                weekly_winner=True,
            ),
        ),
        weekly_winners=("abigail",),
    )

    week_two = _week_result(
        players=(
            _player_result(
                "abigail",
                wins=10,
                losses=5,
                ties=1,
            ),
        ),
        weekly_winners=("bob",),
    )

    result = aggregate_season(
        season=2026,
        weeks=[
            (1, week_one),
            (2, week_two),
        ],
    )

    player = result.players[0]

    assert player.wins == 18
    assert player.losses == 12
    assert player.ties == 2
    assert player.missed_picks == 0
    assert player.accuracy == pytest.approx(0.59375)


@pytest.mark.unit
def test_split_winners_each_receive_weekly_win():
    """Every player in a split receives one weekly season win."""
    week = _week_result(
        players=(
            _player_result(
                "abigail",
                wins=12,
                losses=4,
                weekly_rank=1,
                weekly_winner=True,
            ),
            _player_result(
                "bob",
                wins=12,
                losses=4,
                weekly_rank=1,
                weekly_winner=True,
            ),
        ),
        weekly_winners=(
            "abigail",
            "bob",
        ),
    )

    result = aggregate_season(
        season=2026,
        weeks=[
            (1, week),
        ],
    )

    players = {player.player_id: player for player in result.players}

    assert players["abigail"].weekly_wins == 1
    assert players["bob"].weekly_wins == 1


@pytest.mark.unit
def test_last_place_player_receives_last_place_finish():
    """The lowest-ranked player receives one last-place finish."""
    week = _week_result(
        players=(
            _player_result(
                "abigail",
                weekly_rank=1,
                weekly_winner=True,
            ),
            _player_result(
                "bob",
                weekly_rank=2,
            ),
            _player_result(
                "charlie",
                weekly_rank=3,
            ),
        ),
        weekly_winners=("abigail",),
    )

    result = aggregate_season(
        season=2026,
        weeks=[
            (1, week),
        ],
    )

    players = {player.player_id: player for player in result.players}

    assert players["abigail"].last_place_finishes == 0
    assert players["bob"].last_place_finishes == 0
    assert players["charlie"].last_place_finishes == 1


@pytest.mark.unit
def test_tied_last_place_players_each_receive_last_place_finish():
    """Every player tied for the lowest rank receives a last-place finish."""
    week = _week_result(
        players=(
            _player_result(
                "abigail",
                weekly_rank=1,
                weekly_winner=True,
            ),
            _player_result(
                "bob",
                weekly_rank=2,
            ),
            _player_result(
                "charlie",
                weekly_rank=2,
            ),
        ),
        weekly_winners=("abigail",),
    )

    result = aggregate_season(
        season=2026,
        weeks=[
            (1, week),
        ],
    )

    players = {player.player_id: player for player in result.players}

    assert players["abigail"].last_place_finishes == 0
    assert players["bob"].last_place_finishes == 1
    assert players["charlie"].last_place_finishes == 1


@pytest.mark.unit
def test_player_only_counts_weeks_they_played():
    """Weeks played counts only weeks containing that player."""
    week_one = _week_result(
        players=(
            _player_result(
                "abigail",
                wins=12,
                losses=4,
                missed_picks=1,
                weekly_winner=True,
            ),
            _player_result(
                "bob",
                wins=10,
                losses=6,
                missed_picks=2,
            ),
        ),
        weekly_winners=("abigail",),
    )

    week_two = _week_result(
        players=(
            _player_result(
                "abigail",
                wins=11,
                losses=5,
                missed_picks=1,
                weekly_winner=True,
            ),
        ),
        weekly_winners=("abigail",),
    )

    result = aggregate_season(
        season=2026,
        weeks=[
            (1, week_one),
            (2, week_two),
        ],
    )

    players = {player.player_id: player for player in result.players}

    assert players["abigail"].weeks_played == 2
    assert players["abigail"].missed_picks == 2

    assert players["bob"].weeks_played == 1
    assert players["bob"].missed_picks == 2


@pytest.mark.unit
def test_incomplete_week_does_not_affect_existing_totals():
    """Partial current-week results do not enter season totals."""
    complete_week = _week_result(
        players=(
            _player_result(
                "abigail",
                wins=12,
                losses=4,
                missed_picks=1,
                weekly_winner=True,
            ),
        ),
        weekly_winners=("abigail",),
    )

    incomplete_week = _week_result(
        players=(
            _player_result(
                "abigail",
                wins=2,
                losses=1,
                missed_picks=1,
                weekly_rank=None,
            ),
        ),
        weekly_winners=(),
    )

    result = aggregate_season(
        season=2026,
        weeks=[
            (1, complete_week),
            (2, incomplete_week),
        ],
    )

    player = result.players[0]

    assert result.weeks_scored == (1,)
    assert player.weeks_played == 1
    assert player.wins == 12
    assert player.losses == 4
    assert player.missed_picks == 1


@pytest.mark.unit
def test_only_ties_produces_half_win_percentage():
    """A season containing only ties has a .500 Win %."""
    week = _week_result(
        players=(
            _player_result(
                "abigail",
                ties=1,
                weekly_winner=True,
            ),
        ),
        weekly_winners=("abigail",),
    )

    result = aggregate_season(
        season=2026,
        weeks=[
            (1, week),
        ],
    )

    player = result.players[0]

    assert player.wins == 0
    assert player.losses == 0
    assert player.ties == 1
    assert player.missed_picks == 0
    assert player.accuracy == 0.5


@pytest.mark.unit
def test_players_are_sorted_by_player_id():
    """Season output is deterministic regardless of weekly player order."""
    week = _week_result(
        players=(
            _player_result(
                "charlie",
                wins=8,
                losses=8,
            ),
            _player_result(
                "abigail",
                wins=12,
                losses=4,
                weekly_winner=True,
            ),
            _player_result(
                "bob",
                wins=10,
                losses=6,
            ),
        ),
        weekly_winners=("abigail",),
    )

    result = aggregate_season(
        season=2026,
        weeks=[
            (1, week),
        ],
    )

    assert tuple(player.player_id for player in result.players) == (
        "abigail",
        "bob",
        "charlie",
    )


@pytest.mark.unit
def test_weeks_are_sorted():
    """Season output stores completed week numbers in order."""
    week_one = _week_result(
        players=(
            _player_result(
                "abigail",
                wins=12,
                losses=4,
                weekly_winner=True,
            ),
        ),
        weekly_winners=("abigail",),
    )

    week_two = _week_result(
        players=(
            _player_result(
                "bob",
                wins=12,
                losses=4,
                weekly_winner=True,
            ),
        ),
        weekly_winners=("bob",),
    )

    result = aggregate_season(
        season=2026,
        weeks=[
            (2, week_two),
            (1, week_one),
        ],
    )

    assert result.weeks_scored == (
        1,
        2,
    )


@pytest.mark.unit
def test_duplicate_week_raises_error():
    """The same football week cannot be aggregated twice."""
    week = _week_result(
        players=(
            _player_result(
                "abigail",
                wins=12,
                losses=4,
                weekly_winner=True,
            ),
        ),
        weekly_winners=("abigail",),
    )

    with pytest.raises(
        ValueError,
        match="duplicate week 1",
    ):
        aggregate_season(
            season=2026,
            weeks=[
                (1, week),
                (1, week),
            ],
        )


@pytest.mark.unit
def test_no_weeks_produces_empty_season():
    """An empty season produces an empty aggregate."""
    result = aggregate_season(
        season=2026,
        weeks=[],
    )

    assert result.season == 2026
    assert result.weeks_scored == ()
    assert result.players == ()
