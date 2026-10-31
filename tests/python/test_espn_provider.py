"""Unit tests for the ESPN NFL game-data provider."""

from datetime import UTC, datetime

import pytest
import requests

from pbj.domain.game import GameStatus
from pbj.providers.espn import ESPNProvider


def _espn_event(
    *,
    event_id: str = "401772938",
    state: str = "pre",
    away_score: str | None = None,
    home_score: str | None = None,
) -> dict:
    """Build a minimal ESPN event for testing."""
    return {
        "id": event_id,
        "date": "2026-09-10T00:15Z",
        "status": {
            "type": {
                "state": state,
            },
        },
        "competitions": [
            {
                "competitors": [
                    {
                        "id": "2",
                        "team": {
                            "id": "2",
                            "abbreviation": "BUF",
                            "displayName": "Buffalo Bills",
                        },
                        "homeAway": "away",
                        "score": away_score,
                    },
                    {
                        "id": "3",
                        "team": {
                            "id": "3",
                            "abbreviation": "BAL",
                            "displayName": "Baltimore Ravens",
                        },
                        "homeAway": "home",
                        "score": home_score,
                    },
                ],
            }
        ],
    }


def _scoreboard_response(*events: dict) -> dict:
    """Build a minimal ESPN scoreboard response."""
    return {"events": list(events)}


def _mock_response(mocker, response_data: dict):
    """Create a mocked successful HTTP response."""
    response = mocker.Mock()
    response.raise_for_status.return_value = None
    response.json.return_value = response_data
    mocker.patch("requests.get", return_value=response)
    return response


@pytest.mark.unit
def test_get_week_returns_scheduled_game(mocker):
    """A scheduled ESPN game is normalized correctly."""
    _mock_response(
        mocker,
        _scoreboard_response(_espn_event()),
    )

    games = ESPNProvider().get_week(season=2026, week=1)

    assert len(games) == 1

    game = games[0]

    assert game.id == "401772938"
    assert game.scheduled_time == datetime(
        2026,
        9,
        10,
        0,
        15,
        tzinfo=UTC,
    )
    assert game.away.id == "2"
    assert game.away.abbreviation == "BUF"
    assert game.away.name == "Buffalo Bills"
    assert game.home.id == "3"
    assert game.home.abbreviation == "BAL"
    assert game.home.name == "Baltimore Ravens"
    assert game.status is GameStatus.SCHEDULED
    assert game.away_score is None
    assert game.home_score is None


@pytest.mark.unit
def test_get_week_returns_live_game_with_scores(mocker):
    """A live ESPN game is normalized with its current scores."""
    _mock_response(
        mocker,
        _scoreboard_response(
            _espn_event(
                state="in",
                away_score="14",
                home_score="17",
            )
        ),
    )

    games = ESPNProvider().get_week(season=2026, week=1)

    assert len(games) == 1
    assert games[0].status is GameStatus.LIVE
    assert games[0].away_score == 14
    assert games[0].home_score == 17


@pytest.mark.unit
def test_get_week_returns_final_game(mocker):
    """A final ESPN game is normalized with its final scores."""
    _mock_response(
        mocker,
        _scoreboard_response(
            _espn_event(
                state="post",
                away_score="24",
                home_score="31",
            )
        ),
    )

    games = ESPNProvider().get_week(season=2026, week=1)

    assert len(games) == 1
    assert games[0].status is GameStatus.FINAL
    assert games[0].away_score == 24
    assert games[0].home_score == 31


@pytest.mark.unit
def test_get_week_preserves_tied_final_score(mocker):
    """A final tied game preserves equal scores."""
    _mock_response(
        mocker,
        _scoreboard_response(
            _espn_event(
                state="post",
                away_score="24",
                home_score="24",
            )
        ),
    )

    games = ESPNProvider().get_week(season=2026, week=1)

    assert games[0].status is GameStatus.FINAL
    assert games[0].away_score == 24
    assert games[0].home_score == 24


@pytest.mark.unit
def test_get_week_returns_multiple_games(mocker):
    """All ESPN events are normalized."""
    _mock_response(
        mocker,
        _scoreboard_response(
            _espn_event(event_id="401772938"),
            _espn_event(event_id="401772939"),
        ),
    )

    games = ESPNProvider().get_week(season=2026, week=1)

    assert len(games) == 2
    assert games[0].id == "401772938"
    assert games[1].id == "401772939"


@pytest.mark.unit
def test_get_week_requests_requested_season_and_week(mocker):
    """The provider requests the specified NFL season and week."""
    response = mocker.Mock()
    response.raise_for_status.return_value = None
    response.json.return_value = _scoreboard_response()

    get = mocker.patch("requests.get", return_value=response)

    ESPNProvider().get_week(season=2026, week=8)

    get.assert_called_once()

    request_url = get.call_args.args[0]
    request_params = get.call_args.kwargs["params"]

    assert request_url == ("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard")
    assert request_params["seasontype"] == 2
    assert request_params["week"] == 8
    assert request_params["year"] == 2026


@pytest.mark.unit
def test_get_week_propagates_http_error(mocker):
    """An HTTP error from ESPN is propagated."""
    response = mocker.Mock()
    response.raise_for_status.side_effect = requests.HTTPError("API failure")
    mocker.patch("requests.get", return_value=response)

    with pytest.raises(requests.HTTPError):
        ESPNProvider().get_week(season=2026, week=1)


@pytest.mark.unit
def test_get_week_rejects_missing_event_id(mocker):
    """An ESPN event without an ID cannot be normalized."""
    event = _espn_event()
    del event["id"]

    _mock_response(
        mocker,
        _scoreboard_response(event),
    )

    with pytest.raises(ValueError, match="missing id"):
        ESPNProvider().get_week(season=2026, week=1)


@pytest.mark.unit
def test_get_week_rejects_missing_team(mocker):
    """An ESPN event without required team data cannot be normalized."""
    event = _espn_event()
    del event["competitions"][0]["competitors"][0]["team"]

    _mock_response(
        mocker,
        _scoreboard_response(event),
    )

    with pytest.raises(ValueError, match="missing team data"):
        ESPNProvider().get_week(season=2026, week=1)


@pytest.mark.unit
def test_get_week_rejects_final_game_without_scores(mocker):
    """A final game must contain both final scores."""
    event = _espn_event(
        state="post",
        away_score=None,
        home_score="31",
    )

    _mock_response(
        mocker,
        _scoreboard_response(event),
    )

    with pytest.raises(ValueError, match="missing scores"):
        ESPNProvider().get_week(season=2026, week=1)


@pytest.mark.unit
def test_get_week_rejects_unknown_status(mocker):
    """An ESPN status unknown to the application is rejected."""
    _mock_response(
        mocker,
        _scoreboard_response(
            _espn_event(state="something-new"),
        ),
    )

    with pytest.raises(ValueError, match="unknown status state"):
        ESPNProvider().get_week(season=2026, week=1)
