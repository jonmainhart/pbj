"""Exercise orchestration offline with real PBJ scripts and conditional fake S3."""

import hashlib
import io
import json
from datetime import UTC, datetime
from unittest.mock import Mock

import pytest
from botocore.exceptions import ClientError

from aws import lambda_function as handler
from aws import processing, storage
from pbj.week_data import load_games
from tests.test_aws_lambda import weekly


def error(code):
    return ClientError({"Error": {"Code": code}}, "S3")


class S3:
    def __init__(self):
        self.objects = {}
        self.writes = []
        self.fail = None

    def get_paginator(self, name):
        assert name == "list_objects_v2"
        return self

    def paginate(self, **kwargs):
        assert kwargs["Bucket"] == "pbj-data-jm26"
        self.listed_prefix = kwargs["Prefix"]
        return [
            {"Contents": [{"Key": key} for key in self.objects if key.startswith(kwargs["Prefix"])]}
        ]

    def get_object(self, Bucket, Key):
        assert Bucket == "pbj-data-jm26"
        if Key not in self.objects:
            raise error("NoSuchKey")
        content = self.objects[Key]
        return {"Body": io.BytesIO(content), "ETag": self.etag(content)}

    @staticmethod
    def etag(content):
        return hashlib.sha256(content).hexdigest()

    def put_object(self, **kwargs):
        key = kwargs["Key"]
        if self.fail == key:
            raise error("PreconditionFailed")
        if "IfMatch" in kwargs:
            if key not in self.objects or self.etag(self.objects[key]) != kwargs["IfMatch"]:
                raise error("PreconditionFailed")
        else:
            assert kwargs["IfNoneMatch"] == "*"
            if key in self.objects:
                raise error("PreconditionFailed")
        self.objects[key] = kwargs["Body"]
        self.writes.append(key)

    def seed(self, key, value):
        self.objects[key] = json.dumps(value).encode()

    def data(self, key):
        return json.loads(self.objects[key])


@pytest.fixture
def setup(monkeypatch, tmp_path):
    s3 = S3()
    monkeypatch.setenv("PBJ_DATA_BUCKET", "pbj-data-jm26")
    monkeypatch.setenv("PBJ_DATA_PREFIX", "data/")
    monkeypatch.setenv("PBJ_SEASON", "2026")
    monkeypatch.setenv("PBJ_WEEK1_CREATION_DATE", "2026-09-08")
    monkeypatch.setattr(storage, "client", lambda: s3)
    monkeypatch.setattr(processing, "now", lambda: datetime(2026, 10, 20, tzinfo=UTC))
    path = tmp_path / "week06.json"
    path.write_text(json.dumps(weekly()))
    provider = Mock()
    provider.get_week.return_value = load_games(path)
    monkeypatch.setattr(processing, "provider", lambda: provider)
    return s3, provider


def invoke(action, **kwargs):
    return handler.lambda_handler({"action": action, **kwargs}, None)


def test_create_manifest_and_duplicate(setup):
    s3, provider = setup
    result = invoke("create_week", season=2026, week=1)
    assert result["week"] == 1
    assert s3.data("data/available-weeks.json") == {"2026": [1]}
    document = s3.data("data/2026/week01.json")
    assert "players" not in document
    assert set(document) == {"season", "week", "lock_time", "games"}
    again = invoke("create_week", season=2026, week=1)
    assert again["written"] == []
    assert again["week"] == 1
    assert provider.get_week.call_count == 1
    assert s3.data("data/2026/week01.json") == document


def test_create_week18_and_duplicate(setup):
    s3, provider = setup
    for week in range(1, 18):
        s3.seed(f"data/2026/week{week:02d}.json", {**weekly(), "week": week})
    assert invoke("create_week", week=18)["fetched"]
    assert s3.data("data/available-weeks.json") == {"2026": list(range(1, 19))}
    assert invoke("create_week", week=18)["written"] == []
    provider.get_week.assert_called_once_with(season=2026, week=18)


def test_skip_unnecessary_polling(setup):
    s3, provider = setup
    s3.seed("data/2026/week06.json", weekly())
    result = invoke("poll_games")
    assert not result["fetched"]
    assert not result["scored"]
    provider.get_week.assert_not_called()
    assert s3.data("data/2026/week06.json") == weekly()
    assert s3.data("data/2026/season.json")["weeks_scored"] == []


def test_partial_failure_recovers_without_polling(setup):
    s3, provider = setup
    data = weekly()
    data["games"][0]["status"] = "live"
    s3.seed("data/2026/week06.json", data)
    s3.fail = "data/2026/season.json"
    with pytest.raises(ClientError):
        invoke("poll_games")
    assert "results" in s3.data("data/2026/week06.json")
    s3.fail = None
    result = invoke("poll_games")
    assert "data/2026/season.json" in result["written"]
    assert "data/2026/week06.json" not in result["written"]
    assert not result["fetched"] and not result["scored"]
    assert s3.data("data/2026/season.json")["weeks_scored"] == [6]
    provider.get_week.assert_called_once()


def test_week_conflict_never_publishes_standings(setup):
    s3, _ = setup
    data = weekly()
    data["games"][0]["status"] = "live"
    s3.seed("data/2026/week06.json", data)
    s3.fail = "data/2026/week06.json"
    with pytest.raises(ClientError):
        invoke("poll_games")
    assert s3.writes == []


def test_create_conflict_then_retry_repairs_manifest(setup):
    s3, _ = setup
    s3.fail = "data/available-weeks.json"
    with pytest.raises(ClientError):
        invoke("create_week", season=2026, week=1)
    original = s3.objects["data/2026/week01.json"]
    s3.fail = None
    invoke("create_week", week=1)
    assert s3.objects["data/2026/week01.json"] == original
    assert s3.data("data/available-weeks.json") == {"2026": [1]}


def test_real_concurrent_write_rejects_stale_week(setup):
    s3, provider = setup
    data = weekly()
    data["games"][0]["status"] = "live"
    key = "data/2026/week06.json"
    s3.seed(key, data)
    games = provider.get_week.return_value

    def fetch(**kwargs):
        edited = {**data, "commissioner_note": "concurrent edit"}
        s3.seed(key, edited)
        return games

    provider.get_week.side_effect = fetch
    with pytest.raises(ClientError, match="PreconditionFailed"):
        invoke("poll_games")
    assert s3.data(key)["commissioner_note"] == "concurrent edit"
    assert "data/2026/season.json" not in s3.objects
    provider.get_week.side_effect = None
    invoke("poll_games")
    assert s3.data(key)["commissioner_note"] == "concurrent edit"


def test_creation_race_is_create_only(setup):
    s3, provider = setup
    games = provider.get_week.return_value
    key = "data/2026/week01.json"

    def fetch(**kwargs):
        existing = {**weekly(), "week": 1}
        s3.seed(key, existing)
        return games

    provider.get_week.side_effect = fetch
    with pytest.raises(ClientError, match="PreconditionFailed"):
        invoke("create_week", season=2026, week=1)
    assert s3.data(key)["players"] == weekly()["players"]
    assert s3.writes == []


def test_empty_provider_can_be_retried(setup):
    s3, provider = setup
    games = provider.get_week.return_value
    provider.get_week.return_value = []
    with pytest.raises(ValueError, match="no games"):
        invoke("create_week", season=2026, week=1)
    assert s3.objects == {}
    provider.get_week.return_value = games
    assert invoke("create_week", season=2026, week=1)["fetched"]


def test_delayed_duplicate_repairs_manifest_for_original_week(setup, monkeypatch):
    s3, provider = setup
    event_time = "2026-09-08T12:00:00Z"
    s3.fail = "data/available-weeks.json"
    with pytest.raises(ClientError):
        invoke("create_week", scheduled_time=event_time)
    original = s3.objects["data/2026/week01.json"]
    s3.fail = None
    monkeypatch.setattr(processing, "now", lambda: datetime(2026, 11, 24, tzinfo=UTC))
    assert invoke("create_week", scheduled_time=event_time)["week"] == 1
    assert s3.objects["data/2026/week01.json"] == original
    assert s3.data("data/available-weeks.json") == {"2026": [1]}
    assert invoke("create_week", scheduled_time=event_time)["written"] == []
    provider.get_week.assert_called_once_with(season=2026, week=1)


def test_empty_poll_does_not_require_credentials(setup):
    s3, provider = setup
    assert not invoke("poll_games", season=2026)["fetched"]
    assert s3.data("data/2026/season.json")["players"] == []
    provider.get_week.assert_not_called()


def test_manifest_preserves_other_seasons(setup):
    s3, _ = setup
    data = weekly()
    data["season"] = 2025
    s3.seed("data/2025/week06.json", data)
    invoke("create_week", season=2026, week=1)
    assert s3.data("data/available-weeks.json") == {"2025": [6], "2026": [1]}
    assert s3.data("data/2025/week06.json") == data


def test_api_key_is_decrypted_only_from_named_parameter(monkeypatch):
    import boto3

    client = Mock()
    client.get_parameter.return_value = {"Parameter": {"Value": "offline-test-key"}}
    factory = Mock(return_value=client)
    monkeypatch.setattr(boto3, "client", factory)
    monkeypatch.setenv("PBJ_API_KEY_PARAMETER", "/test/provider-key")
    provider = processing.provider()
    factory.assert_called_once_with("ssm")
    client.get_parameter.assert_called_once_with(Name="/test/provider-key", WithDecryption=True)
    assert provider is not None


def test_scheduled_target_does_not_advance_for_duplicate(setup):
    s3, provider = setup
    invoke("create_week", scheduled_time="2026-09-08T12:00:00Z")
    result = invoke("create_week", scheduled_time="2026-09-15T12:00:00Z")
    assert result["week"] == 2
    assert invoke("create_week", scheduled_time="2026-09-08T12:00:00Z")["written"] == []
    assert s3.data("data/available-weeks.json") == {"2026": [1, 2]}
    assert provider.get_week.call_count == 2


def test_active_week_precedes_future_week(setup):
    s3, provider = setup
    for number, status in ((5, "final"), (6, "live"), (7, "scheduled")):
        document = weekly()
        document["week"] = number
        document["games"][0]["status"] = status
        s3.seed(f"data/2026/week{number:02d}.json", document)
    assert invoke("poll_games")["week"] == 6
    provider.get_week.assert_called_once_with(season=2026, week=6)


def test_other_seasons_are_not_downloaded(setup, monkeypatch):
    s3, _ = setup
    s3.seed("data/2025/week06.json", {**weekly(), "season": 2025})
    read = Mock(wraps=s3.get_object)
    monkeypatch.setattr(s3, "get_object", read)
    invoke("poll_games")
    assert all("2025" not in call.kwargs["Key"] for call in read.call_args_list)


@pytest.mark.parametrize("value", [None, 123, "bad", "2026-10-20T12:00:00"])
def test_invalid_delivery_time_never_calls_aws(setup, monkeypatch, value):
    client = Mock()
    monkeypatch.setattr(storage, "client", client)
    with pytest.raises(ValueError):
        invoke("create_week", scheduled_time=value)
    client.assert_not_called()


def test_missing_season_configuration_fails_before_aws(setup, monkeypatch):
    monkeypatch.delenv("PBJ_SEASON")
    client = Mock()
    monkeypatch.setattr(storage, "client", client)
    with pytest.raises(ValueError, match="season"):
        invoke("poll_games")
    client.assert_not_called()


def test_manual_season_overrides_configuration(setup):
    s3, _ = setup
    invoke("create_week", season=2027, week=1)
    assert "data/2027/week01.json" in s3.objects


@pytest.mark.parametrize(
    ("timestamp", "expected"),
    [
        ("2026-09-08T12:00:00+00:00", 1),
        ("2026-09-09T01:00:00+00:00", 1),  # Still Tuesday in Eastern time.
        ("2026-10-27T12:00:00+00:00", 8),
        ("2026-11-03T13:00:00+00:00", 9),
        ("2027-01-05T13:00:00+00:00", 18),
    ],
)
def test_scheduled_week_uses_original_eastern_date(setup, timestamp, expected):
    assert processing.scheduled_week(datetime.fromisoformat(timestamp)) == expected


@pytest.mark.parametrize("timestamp", ["2026-09-01T12:00:00Z", "2027-01-12T13:00:00Z"])
def test_scheduled_creation_outside_regular_season_is_skipped(setup, timestamp):
    s3, provider = setup
    assert invoke("create_week", scheduled_time=timestamp)["status"] == "skipped"
    assert s3.objects == {}
    provider.get_week.assert_not_called()


@pytest.mark.parametrize("existing, target", [([], 2), ([1], 3), ([1, 3], 2), ([1, 3], 3)])
def test_creation_rejects_gaps_and_out_of_order_targets(setup, existing, target):
    s3, provider = setup
    for week in existing:
        s3.seed(f"data/2026/week{week:02d}.json", {**weekly(), "week": week})
    with pytest.raises(ValueError, match=r"gap|Out-of-order"):
        invoke("create_week", week=target)
    assert s3.writes == []
    provider.get_week.assert_not_called()


@pytest.mark.parametrize("week", [None, True, 0, 19, "1"])
def test_manual_creation_requires_regular_season_week(setup, week):
    s3, provider = setup
    with pytest.raises(ValueError, match="week"):
        invoke("create_week", week=week)
    assert s3.objects == {}
    provider.get_week.assert_not_called()


@pytest.mark.parametrize("prefix", ["data", "data/", "operational/data", "operational/data/"])
def test_configured_prefix_is_normalized_and_scoped(setup, monkeypatch, prefix):
    s3, _ = setup
    monkeypatch.setenv("PBJ_DATA_PREFIX", prefix)
    normalized = prefix.rstrip("/") + "/"
    # A similarly named prefix must not contribute a week or season.
    s3.seed(normalized.rstrip("/") + "-other/2026/week01.json", weekly())
    invoke("create_week", week=1)
    assert s3.listed_prefix == normalized
    assert s3.data(normalized + "available-weeks.json") == {"2026": [1]}
    assert normalized + "2026/week01.json" in s3.objects
    invoke("poll_games")
    assert normalized + "2026/season.json" in s3.objects


@pytest.mark.parametrize("picks", [True, False])
@pytest.mark.parametrize("status", ["live", "final"])
def test_poll_updates_scores_and_preserves_original_fields(setup, picks, status):
    from dataclasses import replace

    from pbj.domain.game import GameStatus

    s3, provider = setup
    data = weekly()
    data["games"][0]["status"] = "live"
    if not picks:
        del data["players"]
    s3.seed("data/2026/week06.json", data)
    game = provider.get_week.return_value[0]
    provider.get_week.return_value = [replace(game, status=GameStatus(status))]
    result = invoke("poll_games")
    updated = s3.data("data/2026/week06.json")
    assert result["fetched"]
    assert result["scored"] == picks
    assert updated["lock_time"] == data["lock_time"]
    assert updated["custom"] == data["custom"]
    assert updated.get("players") == data.get("players")
    assert ("results" in updated) == picks
    assert s3.data("data/2026/season.json")["weeks_scored"] == (
        [6] if picks and status == "final" else []
    )
    assert invoke("poll_games")["written"] == []
