"""Unit tests for the Apple Numbers CSV importer."""

from datetime import UTC, datetime
from io import StringIO

import pytest

from pbj.domain.game import Game, GameStatus, Team
from pbj.importers.numbers import import_players


def _game(
    game_id: str,
    away: str,
    home: str,
) -> Game:
    """Build a normalized game for importer tests."""
    return Game(
        id=game_id,
        scheduled_time=datetime(
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
        status=GameStatus.SCHEDULED,
        away_score=None,
        home_score=None,
    )


@pytest.mark.unit
@pytest.mark.smoke
def test_import_players_imports_normal_row():
    """A normal commissioner row becomes a Player."""
    games = [
        _game("game-1", "NE", "SEA"),
        _game("game-2", "SF", "LAR"),
    ]

    csv_file = StringIO("NAME,NE SEA,SF LAR,TIEBREAKER\nAbigail,SEA,LAR,56\n")

    players = import_players(
        csv_file,
        games,
    )

    assert len(players) == 1

    player = players[0]

    assert player.id == "abigail"
    assert player.name == "Abigail"
    assert player.nickname is None
    assert player.picks == {
        "game-1": "SEA",
        "game-2": "LAR",
    }
    assert player.tiebreaker == 56.0


@pytest.mark.unit
def test_import_players_ignores_columns_after_correct():
    """Columns after CORRECT are outside the PBJ import boundary."""
    games = [
        _game("game-1", "NE", "SEA"),
        _game("game-2", "SF", "LAR"),
    ]

    csv_file = StringIO(
        "NAME,NE SEA,SF LAR,TIEBREAKER,CORRECT,TIEBREAKER DIFF,NOTES\n"
        "Abigail,SEA,LAR,56,,14,commissioner note\n"
    )

    players = import_players(
        csv_file,
        games,
    )

    assert len(players) == 1
    assert players[0].picks == {
        "game-1": "SEA",
        "game-2": "LAR",
    }
    assert players[0].tiebreaker == 56.0


@pytest.mark.unit
def test_import_players_skips_numbers_preamble():
    """The importer finds the actual table header after Numbers metadata."""
    games = [
        _game("game-1", "NE", "SEA"),
    ]

    csv_file = StringIO(
        "PBJ Picks Week 1 2026,,\nPick'Em Master Sheet,,\nNAME,NE SEA,TIEBREAKER\nAbigail,SEA,56\n"
    )

    players = import_players(
        csv_file,
        games,
    )

    assert len(players) == 1
    assert players[0].name == "Abigail"


@pytest.mark.unit
def test_import_players_imports_multiple_players():
    """Multiple commissioner rows become multiple players."""
    games = [
        _game("game-1", "NE", "SEA"),
    ]

    csv_file = StringIO("NAME,NE SEA,TIEBREAKER\nAbigail,SEA,56\nBob,NE,41\n")

    players = import_players(
        csv_file,
        games,
    )

    assert [player.name for player in players] == [
        "Abigail",
        "Bob",
    ]


@pytest.mark.unit
def test_import_players_strips_whitespace():
    """Whitespace from Numbers exports is removed."""
    games = [
        _game("game-1", "NE", "SEA"),
    ]

    csv_file = StringIO("NAME,NE SEA,TIEBREAKER\n D-Rell , SEA , 45 \n")

    players = import_players(
        csv_file,
        games,
    )

    assert players[0].name == "D-Rell"
    assert players[0].id == "d-rell"
    assert players[0].picks == {
        "game-1": "SEA",
    }
    assert players[0].tiebreaker == 45.0


@pytest.mark.unit
def test_import_players_accepts_decimal_tiebreaker():
    """Tiebreaker predictions may contain decimals."""
    games = [
        _game("game-1", "NE", "SEA"),
    ]

    csv_file = StringIO("NAME,NE SEA,TIEBREAKER\nAbigail,SEA,42.5\n")

    players = import_players(
        csv_file,
        games,
    )

    assert players[0].tiebreaker == 42.5


@pytest.mark.unit
@pytest.mark.smoke
def test_import_players_warns_and_omits_non_pick(
    caplog,
):
    """Explicit N/P is noisy but does not stop the import."""
    games = [
        _game("game-1", "NE", "SEA"),
        _game("game-2", "SF", "LAR"),
    ]

    csv_file = StringIO("NAME,NE SEA,SF LAR,TIEBREAKER\nKevin Smalls,N/P,SF,38\n")

    players = import_players(
        csv_file,
        games,
    )

    assert len(players) == 1
    assert players[0].picks == {
        "game-2": "SF",
    }

    assert "Kevin Smalls has no pick for NE vs SEA" in caplog.text


@pytest.mark.unit
def test_import_players_continues_after_non_pick():
    """A later pick is still imported after an N/P cell."""
    games = [
        _game("game-1", "NE", "SEA"),
        _game("game-2", "SF", "LAR"),
        _game("game-3", "ATL", "PIT"),
    ]

    csv_file = StringIO("NAME,NE SEA,SF LAR,ATL PIT,TIEBREAKER\nKevin Smalls,N/P,SF,PIT,38\n")

    players = import_players(
        csv_file,
        games,
    )

    assert players[0].picks == {
        "game-2": "SF",
        "game-3": "PIT",
    }


@pytest.mark.unit
def test_import_players_supports_variable_week_size():
    """Importer does not assume an NFL week contains 16 games."""
    games = [
        _game("game-1", "NE", "SEA"),
        _game("game-2", "SF", "LAR"),
        _game("game-3", "ATL", "PIT"),
    ]

    csv_file = StringIO("NAME,NE SEA,SF LAR,ATL PIT,TIEBREAKER\nAbigail,SEA,LAR,PIT,50\n")

    players = import_players(
        csv_file,
        games,
    )

    assert len(players[0].picks) == 3


@pytest.mark.unit
def test_import_players_resolves_washington_alias_in_matchup():
    """Commissioner WAS columns resolve to the canonical WSH abbreviation."""
    games = [
        _game("game-1", "WSH", "PHI"),
    ]

    csv_file = StringIO("NAME,WAS PHI,TIEBREAKER\nAbigail,PHI,50\n")

    players = import_players(
        csv_file,
        games,
    )

    assert players[0].picks == {
        "game-1": "PHI",
    }


@pytest.mark.unit
def test_import_players_normalizes_washington_alias_in_pick():
    """A WAS pick is stored using canonical abbreviation WSH."""
    games = [
        _game("game-1", "WSH", "PHI"),
    ]

    csv_file = StringIO("NAME,WAS PHI,TIEBREAKER\nAbigail,WAS,50\n")

    players = import_players(
        csv_file,
        games,
    )

    assert players[0].picks == {
        "game-1": "WSH",
    }


@pytest.mark.unit
def test_import_players_resolves_jacksonville_alias_in_matchup():
    """Commissioner JAC columns resolve to the canonical JAX abbreviation."""
    games = [
        _game("game-1", "CLE", "JAX"),
    ]

    csv_file = StringIO("NAME,CLE JAC,TIEBREAKER\nAbigail,JAC,50\n")

    players = import_players(
        csv_file,
        games,
    )

    assert players[0].picks == {
        "game-1": "JAX",
    }


@pytest.mark.unit
def test_import_players_rejects_unknown_matchup():
    """Spreadsheet matchups must resolve to exactly one schedule game."""
    games = [
        _game("game-1", "NE", "SEA"),
    ]

    csv_file = StringIO("NAME,BUF MIA,TIEBREAKER\nAbigail,BUF,50\n")

    with pytest.raises(
        ValueError,
        match="could not resolve matchup BUF vs MIA",
    ):
        import_players(
            csv_file,
            games,
        )


@pytest.mark.unit
def test_import_players_rejects_invalid_pick():
    """A pick must be one of the two teams in the resolved game."""
    games = [
        _game("game-1", "NE", "SEA"),
    ]

    csv_file = StringIO("NAME,NE SEA,TIEBREAKER\nAbigail,BUF,50\n")

    with pytest.raises(
        ValueError,
        match="Abigail has invalid pick 'BUF' for NE vs SEA",
    ):
        import_players(
            csv_file,
            games,
        )


@pytest.mark.unit
def test_import_players_rejects_blank_pick():
    """Blank picks are errors rather than explicit non-picks."""
    games = [
        _game("game-1", "NE", "SEA"),
    ]

    csv_file = StringIO("NAME,NE SEA,TIEBREAKER\nAbigail,,50\n")

    with pytest.raises(
        ValueError,
        match="Abigail is missing pick",
    ):
        import_players(
            csv_file,
            games,
        )


@pytest.mark.unit
def test_import_players_rejects_missing_tiebreaker():
    """Every player must provide a tiebreaker prediction."""
    games = [
        _game("game-1", "NE", "SEA"),
    ]

    csv_file = StringIO("NAME,NE SEA,TIEBREAKER\nAbigail,SEA,\n")

    with pytest.raises(
        ValueError,
        match="Abigail is missing tiebreaker",
    ):
        import_players(
            csv_file,
            games,
        )


@pytest.mark.unit
def test_import_players_rejects_invalid_tiebreaker():
    """Tiebreaker predictions must be numeric."""
    games = [
        _game("game-1", "NE", "SEA"),
    ]

    csv_file = StringIO("NAME,NE SEA,TIEBREAKER\nAbigail,SEA,nope\n")

    with pytest.raises(
        ValueError,
        match="Abigail has invalid tiebreaker 'nope'",
    ):
        import_players(
            csv_file,
            games,
        )


@pytest.mark.unit
def test_import_players_rejects_missing_name():
    """Every commissioner row must identify its player."""
    games = [
        _game("game-1", "NE", "SEA"),
    ]

    csv_file = StringIO("NAME,NE SEA,TIEBREAKER\n,SEA,50\n")

    with pytest.raises(
        ValueError,
        match="missing player name",
    ):
        import_players(
            csv_file,
            games,
        )
