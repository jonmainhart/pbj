"""Unit tests for the weekly game-update workflow."""

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

from pbj.domain.game import Game, GameStatus, Team
from pbj.providers.balldontlie import BALLDONTLIEProvider
from pbj.providers.espn import ESPNProvider
from scripts.update_games import _create_provider, _parse_args, _resolve_api_key, update_week


def _game(
    *,
    game_id: str = "game-1",
    scheduled_time: datetime | None = None,
    status: GameStatus = GameStatus.SCHEDULED,
    away_score: int | None = None,
    home_score: int | None = None,
) -> Game:
    """Build a normalized game for update tests."""
    if scheduled_time is None:
        scheduled_time = datetime(
            2026,
            9,
            10,
            0,
            15,
            tzinfo=UTC,
        )

    return Game(
        id=game_id,
        scheduled_time=scheduled_time,
        away=Team(
            id="1",
            abbreviation="NE",
            name="New England Patriots",
        ),
        home=Team(
            id="26",
            abbreviation="SEA",
            name="Seattle Seahawks",
        ),
        status=status,
        away_score=away_score,
        home_score=home_score,
    )


def _provider(mocker, games):
    """Return a mocked game provider."""
    provider = mocker.Mock()
    provider.get_week.return_value = games
    return provider


@pytest.mark.unit
def test_update_week_creates_week_file(tmp_path, mocker):
    """Game updates create a new weekly JSON file."""
    path = tmp_path / "2026" / "week01.json"

    provider = _provider(
        mocker,
        [_game()],
    )

    update_week(
        path=path,
        season=2026,
        week=1,
        provider=provider,
    )

    data = json.loads(path.read_text())

    assert data["season"] == 2026
    assert data["week"] == 1
    assert len(data["games"]) == 1

    game = data["games"][0]

    assert game["id"] == "game-1"
    assert game["away"]["abbreviation"] == "NE"
    assert game["home"]["abbreviation"] == "SEA"
    assert game["status"] == "scheduled"
    assert game["away_score"] is None
    assert game["home_score"] is None


@pytest.mark.unit
def test_update_week_requests_correct_season_and_week(
    tmp_path,
    mocker,
):
    """The workflow requests the specified provider week."""
    path = tmp_path / "week01.json"

    provider = _provider(
        mocker,
        [_game()],
    )

    update_week(
        path=path,
        season=2026,
        week=1,
        provider=provider,
    )

    provider.get_week.assert_called_once_with(
        season=2026,
        week=1,
    )


@pytest.mark.unit
@pytest.mark.smoke
def test_update_week_sets_lock_time_from_first_game(
    tmp_path,
    mocker,
):
    """A new week locks one hour before its earliest scheduled game."""
    path = tmp_path / "week01.json"

    first_game = _game(
        game_id="early",
        scheduled_time=datetime(
            2026,
            9,
            10,
            17,
            0,
            tzinfo=UTC,
        ),
    )

    later_game = _game(
        game_id="late",
        scheduled_time=datetime(
            2026,
            9,
            10,
            20,
            0,
            tzinfo=UTC,
        ),
    )

    provider = _provider(
        mocker,
        [later_game, first_game],
    )

    update_week(
        path=path,
        season=2026,
        week=1,
        provider=provider,
    )

    data = json.loads(path.read_text())

    assert data["lock_time"] == "2026-09-10T16:00:00+00:00"
    assert data["games"][0]["id"] == "early"
    assert data["games"][1]["id"] == "late"


@pytest.mark.unit
def test_update_week_preserves_existing_lock_time(
    tmp_path,
    mocker,
):
    """Schedule changes do not silently change an established lock time."""
    path = tmp_path / "week01.json"

    path.write_text(
        json.dumps(
            {
                "season": 2026,
                "week": 1,
                "lock_time": "2026-09-10T16:00:00+00:00",
            }
        )
    )

    rescheduled_game = _game(
        scheduled_time=datetime(
            2026,
            9,
            10,
            19,
            0,
            tzinfo=UTC,
        ),
    )

    provider = _provider(
        mocker,
        [rescheduled_game],
    )

    update_week(
        path=path,
        season=2026,
        week=1,
        provider=provider,
    )

    data = json.loads(path.read_text())

    assert data["lock_time"] == "2026-09-10T16:00:00+00:00"


@pytest.mark.unit
def test_update_week_preserves_players(
    tmp_path,
    mocker,
):
    """Updating provider game data does not modify commissioner picks."""
    path = tmp_path / "week01.json"

    players = [
        {
            "id": "abigail",
            "name": "Abigail",
            "nickname": None,
            "picks": {
                "game-1": "SEA",
            },
            "tiebreaker": 56.0,
        }
    ]

    path.write_text(
        json.dumps(
            {
                "season": 2026,
                "week": 1,
                "players": players,
            }
        )
    )

    provider = _provider(
        mocker,
        [_game()],
    )

    update_week(
        path=path,
        season=2026,
        week=1,
        provider=provider,
    )

    data = json.loads(path.read_text())

    assert data["players"] == players


@pytest.mark.unit
def test_update_week_preserves_results(
    tmp_path,
    mocker,
):
    """Updating game data does not directly modify derived results."""
    path = tmp_path / "week01.json"

    results: dict[str, object] = {
        "monday_total": None,
        "player_count": 1,
        "weekly_winners": [],
        "players": [],
    }

    path.write_text(
        json.dumps(
            {
                "season": 2026,
                "week": 1,
                "results": results,
            }
        )
    )

    provider = _provider(
        mocker,
        [_game()],
    )

    update_week(
        path=path,
        season=2026,
        week=1,
        provider=provider,
    )

    data = json.loads(path.read_text())

    assert data["results"] == results


@pytest.mark.unit
@pytest.mark.smoke
def test_update_week_replaces_only_game_data(
    tmp_path,
    mocker,
):
    """A later provider update replaces existing normalized game data."""
    path = tmp_path / "week01.json"

    path.write_text(
        json.dumps(
            {
                "season": 2026,
                "week": 1,
                "games": [
                    {
                        "id": "game-1",
                        "status": "scheduled",
                        "away_score": None,
                        "home_score": None,
                    }
                ],
                "players": [{"id": "abigail"}],
            }
        )
    )

    provider = _provider(
        mocker,
        [
            _game(
                status=GameStatus.FINAL,
                away_score=17,
                home_score=24,
            )
        ],
    )

    update_week(
        path=path,
        season=2026,
        week=1,
        provider=provider,
    )

    data = json.loads(path.read_text())

    assert data["games"][0]["status"] == "final"
    assert data["games"][0]["away_score"] == 17
    assert data["games"][0]["home_score"] == 24

    assert data["players"] == [{"id": "abigail"}]


@pytest.mark.unit
def test_update_week_rejects_empty_schedule(
    tmp_path,
    mocker,
):
    """An empty provider response must not overwrite existing data."""
    path = tmp_path / "week01.json"

    original_data = {
        "season": 2026,
        "week": 1,
        "games": [{"id": "existing-game"}],
    }

    path.write_text(json.dumps(original_data))

    provider = _provider(
        mocker,
        [],
    )

    with pytest.raises(
        ValueError,
        match="returned no games",
    ):
        update_week(
            path=path,
            season=2026,
            week=1,
            provider=provider,
        )

    assert json.loads(path.read_text()) == original_data


@pytest.mark.unit
def test_update_week_rejects_wrong_existing_season(
    tmp_path,
    mocker,
):
    """An existing file for another season is not overwritten."""
    path = tmp_path / "week01.json"

    path.write_text(
        json.dumps(
            {
                "season": 2025,
                "week": 1,
            }
        )
    )

    provider = _provider(
        mocker,
        [_game()],
    )

    with pytest.raises(
        ValueError,
        match="season 2025",
    ):
        update_week(
            path=path,
            season=2026,
            week=1,
            provider=provider,
        )


@pytest.mark.unit
def test_update_week_rejects_wrong_existing_week(
    tmp_path,
    mocker,
):
    """An existing file for another week is not overwritten."""
    path = tmp_path / "week01.json"

    path.write_text(
        json.dumps(
            {
                "season": 2026,
                "week": 2,
            }
        )
    )

    provider = _provider(
        mocker,
        [_game()],
    )

    with pytest.raises(
        ValueError,
        match="week 2",
    ):
        update_week(
            path=path,
            season=2026,
            week=1,
            provider=provider,
        )


@pytest.mark.unit
def test_create_provider_returns_espn_provider():
    """ESPN can be selected as the game-data provider."""
    provider = _create_provider("espn")

    assert isinstance(provider, ESPNProvider)


@pytest.mark.unit
def test_create_provider_returns_balldontlie_provider():
    """BALLDONTLIE can be selected as the game-data provider."""
    provider = _create_provider(
        "balldontlie",
        api_key="test-api-key",
    )

    assert isinstance(provider, BALLDONTLIEProvider)


@pytest.mark.unit
def test_create_provider_rejects_balldontlie_without_api_key():
    """BALLDONTLIE cannot be selected without an API key."""
    with pytest.raises(
        ValueError,
        match="requires an API key",
    ):
        _create_provider("balldontlie")


@pytest.mark.unit
def test_create_provider_rejects_unknown_provider():
    """An unknown game-data provider is rejected."""
    with pytest.raises(
        ValueError,
        match="Unknown game provider",
    ):
        _create_provider("something-else")


@pytest.mark.unit
def test_parse_args_defaults_to_espn(mocker):
    """ESPN remains the default provider when none is specified."""
    mocker.patch(
        "sys.argv",
        ["update_games.py", "2026", "3"],
    )

    args = _parse_args()

    assert args.season == 2026
    assert args.week == 3
    assert args.provider == "espn"
    assert args.api_key is None


@pytest.mark.unit
def test_parse_args_accepts_balldontlie_provider(mocker):
    """BALLDONTLIE can be explicitly selected from the command line."""
    mocker.patch(
        "sys.argv",
        [
            "update_games.py",
            "2026",
            "3",
            "--provider",
            "balldontlie",
            "--api-key",
            "test-api-key",
        ],
    )

    args = _parse_args()

    assert args.provider == "balldontlie"
    assert args.api_key == "test-api-key"


@pytest.mark.unit
def test_resolve_api_key_uses_environment(mocker):
    """The BALLDONTLIE API key can be supplied through the environment."""
    mocker.patch.dict(
        "os.environ",
        {"BALLDONTLIE_API_KEY": "environment-api-key"},
    )

    api_key = _resolve_api_key(None)

    assert api_key == "environment-api-key"


@pytest.mark.unit
def test_resolve_api_key_prefers_explicit_key(mocker):
    """An explicit API key takes precedence over the environment."""
    mocker.patch.dict(
        "os.environ",
        {"BALLDONTLIE_API_KEY": "environment-api-key"},
    )

    api_key = _resolve_api_key("explicit-api-key")

    assert api_key == "explicit-api-key"


@pytest.mark.unit
def test_main_uses_selected_provider(mocker):
    """The update command uses the provider selected at runtime."""
    args = mocker.Mock(
        season=2026,
        week=3,
        provider="balldontlie",
        api_key="test-api-key",
    )

    mocker.patch(
        "scripts.update_games._parse_args",
        return_value=args,
    )

    provider = mocker.Mock()

    create_provider = mocker.patch(
        "scripts.update_games._create_provider",
        return_value=provider,
    )

    update_week_mock = mocker.patch(
        "scripts.update_games.update_week",
    )

    from scripts.update_games import main

    main()

    create_provider.assert_called_once_with(
        "balldontlie",
        api_key="test-api-key",
    )

    update_week_mock.assert_called_once_with(
        path=Path("data/2026/week03.json"),
        season=2026,
        week=3,
        provider=provider,
    )
