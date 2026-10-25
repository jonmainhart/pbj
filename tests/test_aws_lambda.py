"""Offline tests for the permanent Lambda scoring adapter."""

import io
import json
from unittest.mock import Mock

import pytest
from botocore.exceptions import ClientError

from aws import lambda_function as handler
from scripts.score_week import score_week_file


@pytest.fixture
def s3(monkeypatch):
    client = Mock()
    monkeypatch.setenv("PBJ_DATA_BUCKET", "pbj-data-jm26")
    monkeypatch.setattr(handler, "_s3_client", lambda: client)
    return client


def weekly():
    return {
        "season": 2026,
        "week": 6,
        "lock_time": "2026-10-19T23:00:00+00:00",
        "games": [
            {
                "id": "game-1",
                "scheduled_time": "2026-10-20T00:15:00+00:00",
                "away": {"id": "NE", "abbreviation": "NE", "name": "New England Patriots"},
                "home": {"id": "SEA", "abbreviation": "SEA", "name": "Seattle Seahawks"},
                "status": "final",
                "away_score": 10,
                "home_score": 17,
            }
        ],
        "players": [
            {
                "id": "player-1",
                "name": "Test Player",
                "nickname": None,
                "picks": {"game-1": "SEA"},
                "tiebreaker": 27,
            }
        ],
        "custom": {"keep": [1, "value"]},
    }


def download(s3, data):
    s3.get_object.return_value = {
        "Body": io.BytesIO(json.dumps(data).encode()),
        "ETag": '"original"',
    }


def event(**kwargs):
    return {"action": "score_week", "season": 2026, "week": 6, **kwargs}


@pytest.mark.parametrize("write", [None, False, True])
def test_actual_scoring_and_preservation(s3, write):
    data = weekly()
    data["results"] = {}
    download(s3, data)
    result = handler.lambda_handler(event(**({} if write is None else {"write": write})), None)
    assert result == {
        "status": "ok",
        "action": "score_week",
        "season": 2026,
        "week": 6,
        "key": "data/2026/week06.json",
        "changed": True,
        "written": write is True,
    }
    s3.get_object.assert_called_once_with(Bucket="pbj-data-jm26", Key=result["key"])
    if write:
        s3.put_object.assert_called_once()
        args = s3.put_object.call_args.kwargs
        assert args["IfMatch"] == '"original"'
        assert args["Key"] == result["key"]
        assert args["Bucket"] == "pbj-data-jm26"
        scored = json.loads(args["Body"])
        assert scored["results"]["player_count"] == len(data["players"])
        assert scored["results"]["weekly_winners"]
        assert {k: v for k, v in scored.items() if k != "results"} == {
            k: v for k, v in data.items() if k != "results"
        }
    else:
        s3.put_object.assert_not_called()


def test_semantically_unchanged(s3, tmp_path):
    path = tmp_path / "week06.json"
    path.write_text(json.dumps(weekly()))
    score_week_file(path, 2026, 6)
    download(s3, json.loads(path.read_text()))
    result = handler.lambda_handler(event(write=True), None)
    assert result["changed"] is False
    assert result["written"] is False
    s3.put_object.assert_not_called()


@pytest.mark.parametrize(
    "invalid",
    [
        None,
        [],
        "score_week",
        {"write": True},
        event(action="other"),
        event(season=True),
        event(season="2026"),
        event(season=0),
        event(season=10000),
        event(week=True),
        event(week=0),
        event(week=19),
        event(week=6.0),
        event(write="false"),
        event(write=1),
        event(write=None),
        {"action": "score_week"},
    ],
)
def test_invalid_event(s3, invalid):
    with pytest.raises(ValueError):
        handler.lambda_handler(invalid, None)
    s3.get_object.assert_not_called()
    s3.put_object.assert_not_called()


@pytest.mark.parametrize(
    "data",
    [[], {}, {"season": 2026, "week": 5}, {"season": 2026, "week": 6, "games": [], "players": []}],
)
def test_malformed_week(s3, data):
    download(s3, data)
    with pytest.raises(ValueError):
        handler.lambda_handler(event(write=True), None)
    s3.put_object.assert_not_called()


def test_invalid_json(s3):
    s3.get_object.return_value = {"Body": io.BytesIO(b"broken"), "ETag": '"e"'}
    with pytest.raises(ValueError):
        handler.lambda_handler(event(write=True), None)
    s3.put_object.assert_not_called()


def test_missing_week(s3):
    error = ClientError(
        {"Error": {"Code": "NoSuchKey", "Message": "The specified key does not exist."}},
        "GetObject",
    )
    s3.get_object.side_effect = error
    with pytest.raises(ClientError) as exc_info:
        handler.lambda_handler(event(write=True), None)
    assert exc_info.value is error
    s3.put_object.assert_not_called()


@pytest.mark.parametrize("code", ["PreconditionFailed", "ConditionalRequestConflict"])
def test_conflict_is_not_retried(s3, code):
    data = weekly()
    data.pop("results", None)
    download(s3, data)
    s3.put_object.side_effect = RuntimeError(code)
    with pytest.raises(RuntimeError, match=code):
        handler.lambda_handler(event(write=True), None)
    s3.get_object.assert_called_once()
    s3.put_object.assert_called_once()


def test_smoke_needs_no_configuration_or_sdk(s3, monkeypatch):
    monkeypatch.delenv("PBJ_DATA_BUCKET", raising=False)
    result = handler.lambda_handler({}, None)
    assert result["status"] == "ok"
    assert "scripts.score_week" in result["modules"]
    s3.get_object.assert_not_called()
