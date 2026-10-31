"""Unit tests for the BALLDONTLIE NFL game-data provider."""

from datetime import UTC, datetime

import pytest
import requests

from pbj.domain.game import GameStatus
from pbj.providers.balldontlie import BALLDONTLIEProvider


def _balldontlie_game(
    *,
    game_id: int = 1392263,
    status_state: str = "scheduled",
    away_score: int | None = None,
    home_score: int | None = None,
) -> dict:
    """Build a minimal BALLDONTLIE game for testing."""
    return {
        "id": game_id,
        "visitor_team": {
            "id": 18,
            "full_name": "Philadelphia Eagles",
            "abbreviation": "PHI",
        },
        "home_team": {
            "id": 24,
            "full_name": "Chicago Bears",
            "abbreviation": "CHI",
        },
        "week": 3,
        "date": "2026-09-29T00:15:00.000Z",
        "season": 2026,
        "status_state": status_state,
        "home_team_score": home_score,
        "visitor_team_score": away_score,
    }


def _games_response(*games: dict) -> dict:
    """Build a minimal BALLDONTLIE games response."""
    return {"data": list(games)}


def _mock_response(mocker, response_data: dict):
    """Create a mocked successful HTTP response."""
    response = mocker.Mock()
    response.raise_for_status.return_value = None
    response.json.return_value = response_data
    mocker.patch("requests.get", return_value=response)
    return response


@pytest.mark.unit
def test_get_week_returns_scheduled_game(mocker):
    """A scheduled BALLDONTLIE game is normalized correctly."""
    _mock_response(
        mocker,
        _games_response(_balldontlie_game()),
    )

    games = BALLDONTLIEProvider(
        api_key="test-api-key",
    ).get_week(
        season=2026,
        week=3,
    )

    assert len(games) == 1

    game = games[0]

    assert game.id == "1392263"
    assert game.scheduled_time == datetime(
        2026,
        9,
        29,
        0,
        15,
        tzinfo=UTC,
    )
    assert game.away.id == "18"
    assert game.away.abbreviation == "PHI"
    assert game.away.name == "Philadelphia Eagles"
    assert game.home.id == "24"
    assert game.home.abbreviation == "CHI"
    assert game.home.name == "Chicago Bears"
    assert game.status is GameStatus.SCHEDULED
    assert game.away_score is None
    assert game.home_score is None


@pytest.mark.unit
@pytest.mark.smoke
def test_get_week_returns_live_game_with_scores(mocker):
    """A live BALLDONTLIE game is normalized with its current scores."""
    _mock_response(
        mocker,
        _games_response(
            _balldontlie_game(
                status_state="in_progress",
                away_score=14,
                home_score=17,
            )
        ),
    )

    games = BALLDONTLIEProvider(
        api_key="test-api-key",
    ).get_week(
        season=2026,
        week=3,
    )

    assert len(games) == 1
    assert games[0].status is GameStatus.LIVE
    assert games[0].away_score == 14
    assert games[0].home_score == 17


@pytest.mark.unit
def test_get_week_returns_final_game(mocker):
    """A final BALLDONTLIE game is normalized with its final scores."""
    _mock_response(
        mocker,
        _games_response(
            _balldontlie_game(
                status_state="final",
                away_score=24,
                home_score=31,
            )
        ),
    )

    games = BALLDONTLIEProvider(
        api_key="test-api-key",
    ).get_week(
        season=2026,
        week=3,
    )

    assert len(games) == 1
    assert games[0].status is GameStatus.FINAL
    assert games[0].away_score == 24
    assert games[0].home_score == 31


@pytest.mark.unit
def test_get_week_preserves_tied_final_score(mocker):
    """A final tied game preserves equal scores."""
    _mock_response(
        mocker,
        _games_response(
            _balldontlie_game(
                status_state="final",
                away_score=24,
                home_score=24,
            )
        ),
    )

    games = BALLDONTLIEProvider(
        api_key="test-api-key",
    ).get_week(
        season=2026,
        week=3,
    )

    assert games[0].status is GameStatus.FINAL
    assert games[0].away_score == 24
    assert games[0].home_score == 24


@pytest.mark.unit
def test_get_week_returns_multiple_games(mocker):
    """All BALLDONTLIE games are normalized."""
    _mock_response(
        mocker,
        _games_response(
            _balldontlie_game(game_id=1392262),
            _balldontlie_game(game_id=1392263),
        ),
    )

    games = BALLDONTLIEProvider(
        api_key="test-api-key",
    ).get_week(
        season=2026,
        week=3,
    )

    assert len(games) == 2
    assert games[0].id == "1392262"
    assert games[1].id == "1392263"


@pytest.mark.unit
def test_get_week_requests_requested_season_and_week(mocker):
    """The provider requests the specified NFL season and week."""
    response = mocker.Mock()
    response.raise_for_status.return_value = None
    response.json.return_value = _games_response()

    get = mocker.patch("requests.get", return_value=response)

    BALLDONTLIEProvider(
        api_key="test-api-key",
    ).get_week(
        season=2026,
        week=8,
    )

    get.assert_called_once()

    request_url = get.call_args.args[0]
    request_params = get.call_args.kwargs["params"]
    request_headers = get.call_args.kwargs["headers"]

    assert request_url == ("https://api.balldontlie.io/nfl/v1/games")
    assert request_params["seasons[]"] == 2026
    assert request_params["weeks[]"] == 8
    assert request_headers["Authorization"] == "test-api-key"


@pytest.mark.unit
def test_get_week_propagates_http_error(mocker):
    """An HTTP error from BALLDONTLIE is propagated."""
    response = mocker.Mock()
    response.raise_for_status.side_effect = requests.HTTPError("API failure")
    mocker.patch("requests.get", return_value=response)

    with pytest.raises(requests.HTTPError):
        BALLDONTLIEProvider(
            api_key="test-api-key",
        ).get_week(
            season=2026,
            week=3,
        )


@pytest.mark.unit
def test_get_week_rejects_missing_game_id(mocker):
    """A BALLDONTLIE game without an ID cannot be normalized."""
    game = _balldontlie_game()
    del game["id"]

    _mock_response(
        mocker,
        _games_response(game),
    )

    with pytest.raises(ValueError, match="missing id"):
        BALLDONTLIEProvider(
            api_key="test-api-key",
        ).get_week(
            season=2026,
            week=3,
        )


@pytest.mark.unit
def test_get_week_rejects_missing_team(mocker):
    """A BALLDONTLIE game without required team data cannot be normalized."""
    game = _balldontlie_game()
    del game["visitor_team"]

    _mock_response(
        mocker,
        _games_response(game),
    )

    with pytest.raises(ValueError, match="missing team data"):
        BALLDONTLIEProvider(
            api_key="test-api-key",
        ).get_week(
            season=2026,
            week=3,
        )


@pytest.mark.unit
def test_get_week_rejects_final_game_without_scores(mocker):
    """A final game must contain both final scores."""
    game = _balldontlie_game(
        status_state="final",
        away_score=None,
        home_score=31,
    )

    _mock_response(
        mocker,
        _games_response(game),
    )

    with pytest.raises(ValueError, match="missing scores"):
        BALLDONTLIEProvider(
            api_key="test-api-key",
        ).get_week(
            season=2026,
            week=3,
        )


@pytest.mark.unit
def test_get_week_rejects_unknown_status(mocker):
    """A BALLDONTLIE status unknown to the application is rejected."""
    _mock_response(
        mocker,
        _games_response(
            _balldontlie_game(
                status_state="something-new",
            ),
        ),
    )

    with pytest.raises(
        ValueError,
        match="unknown status state",
    ):
        BALLDONTLIEProvider(
            api_key="test-api-key",
        ).get_week(
            season=2026,
            week=3,
        )
