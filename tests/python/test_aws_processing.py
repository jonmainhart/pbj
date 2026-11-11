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

from .test_aws_lambda import weekly


def error(code):
    return ClientError({"Error": {"Code": code}}, "S3")


class S3:
    def __init__(self):
        self.objects = {}
        self.writes = []
        self.metadata = {}
        self.fail = None

    def get_paginator(self, name):
        assert name == "list_objects_v2"
        return self

    def paginate(self, **kwargs):
        assert kwargs["Bucket"] == "pbj-data-jm26"
        self.listed_prefix = kwargs["Prefix"]
        return [
            {
                "Contents": [
                    {"Key": key, "ETag": self.etag(self.objects[key])}
                    for key in self.objects
                    if key.startswith(kwargs["Prefix"])
                ]
            }
        ]

    def get_object(self, Bucket, Key):
        assert Bucket == "pbj-data-jm26"
        if Key not in self.objects:
            raise error("NoSuchKey")
        content = self.objects[Key]
        return {
            "Body": io.BytesIO(content),
            "ETag": self.etag(content),
            "Metadata": self.metadata.get(Key, {}),
        }

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
        self.metadata[key] = kwargs.get("Metadata", {})
        self.objects[key] = kwargs["Body"]
        self.writes.append(key)

    def seed(self, key, value):
        self.metadata.pop(key, None)
        self.objects[key] = json.dumps(value).encode()

    def data(self, key):
        return json.loads(self.objects[key])


@pytest.fixture
def setup(monkeypatch, tmp_path):
    s3 = S3()
    monkeypatch.setenv("PBJ_DATA_BUCKET", "pbj-data-jm26")
    monkeypatch.setenv("PBJ_DATA_PREFIX", "data/")
    monkeypatch.setenv("PBJ_INPUT_PREFIX", "incoming/")
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


CSV_KEY = "incoming/2026/week06.csv"
WEEK_KEY = "data/2026/week06.json"
SEASON_KEY = "data/2026/season.json"
CSV = b"Commissioner export\nNAME,NE SEA,TIEBREAKER,CORRECT\nTest Player,SEA,27,99\nBob,NE,30,99\n"


def seed_import(s3):
    s3.seed(WEEK_KEY, weekly())
    s3.objects[CSV_KEY] = CSV


def import_week():
    return invoke("import_picks", season=2026, week=6)


@pytest.mark.smoke
def test_import_real_pipeline_and_duplicate(setup, tmp_path):
    from scripts import aggregate_season, import_picks, score_week

    s3, provider = setup
    seed_import(s3)
    previous = {**weekly(), "week": 5}
    path = tmp_path / "week05.json"
    path.write_text(json.dumps(previous))
    score_week.score_week_file(path, 2026, 5)
    s3.objects["data/2026/week05.json"] = path.read_bytes()
    path = tmp_path / "week06.json"
    path.write_text(json.dumps(weekly()))
    csv_path = path.with_suffix(".csv")
    csv_path.write_bytes(CSV)
    import_picks.import_picks_file(path, csv_path, 2026, 6)
    score_week.score_week_file(path, 2026, 6)
    aggregate_season.aggregate_season_files(2026, tmp_path)

    assert import_week()["written"] == [WEEK_KEY, SEASON_KEY]
    updated = s3.data(WEEK_KEY)
    assert updated == json.loads(path.read_bytes())
    assert s3.data(SEASON_KEY) == json.loads((tmp_path / "season.json").read_bytes())
    assert updated["games"] == weekly()["games"]
    assert updated["lock_time"] == weekly()["lock_time"]
    assert updated["custom"] == weekly()["custom"]
    assert updated["players"][0] == {**weekly()["players"][0], "id": "test-player"}
    assert updated["players"][1]["picks"] == {"game-1": "NE"}
    assert updated["players"][1]["tiebreaker"] == 30
    assert s3.data(SEASON_KEY)["weeks_scored"] == [5, 6]
    assert s3.objects[CSV_KEY] == CSV
    assert not csv_path.exists()
    writes = s3.writes.copy()
    assert import_week()["written"] == []
    assert s3.writes == writes
    provider.get_week.assert_not_called()


@pytest.mark.parametrize("content", [None, b"bad", b"NAME,NE SEA,TIEBREAKER\nBob,BUF,30\n", b""])
def test_import_missing_or_invalid_csv_preserves_s3(setup, content):
    s3, _ = setup
    seed_import(s3)
    s3.seed(SEASON_KEY, {"original": True})
    if content is None:
        del s3.objects[CSV_KEY]
    else:
        s3.objects[CSV_KEY] = content
    original = s3.objects.copy()
    with pytest.raises((ValueError, ClientError)):
        import_week()
    assert s3.objects == original
    assert s3.writes == []


def test_import_requires_existing_week(setup):
    s3, _ = setup
    s3.objects[CSV_KEY] = CSV
    with pytest.raises(ClientError, match="NoSuchKey"):
        import_week()
    assert s3.writes == []


def test_import_correction_rebuilds_standings(setup):
    s3, _ = setup
    seed_import(s3)
    import_week()
    original = s3.data(SEASON_KEY)
    corrected = CSV.replace(b"Bob,NE,30", b"Bob,SEA,27")
    s3.objects[CSV_KEY] = corrected
    assert import_week()["written"] == [WEEK_KEY, SEASON_KEY]
    assert s3.data(SEASON_KEY) != original
    assert s3.data(WEEK_KEY)["players"][1]["picks"] == {"game-1": "SEA"}
    assert s3.objects[CSV_KEY] == corrected
    assert import_week()["written"] == []


@pytest.mark.parametrize("key", [WEEK_KEY, SEASON_KEY])
@pytest.mark.parametrize("code", ["PreconditionFailed", "ConditionalRequestConflict"])
def test_import_conditional_conflict_and_recovery(setup, monkeypatch, key, code):
    s3, _ = setup
    seed_import(s3)
    put = s3.put_object

    def conflict(**kwargs):
        if kwargs["Key"] == key:
            s3.seed(key, {**s3.data(key), "concurrent": True} if key == WEEK_KEY else {})
            raise error(code)
        put(**kwargs)

    monkeypatch.setattr(s3, "put_object", conflict)
    with pytest.raises(ClientError, match=code):
        import_week()
    if key == WEEK_KEY:
        assert s3.writes == []
        assert s3.data(key)["concurrent"]
        assert SEASON_KEY not in s3.objects
    else:
        assert s3.writes == [WEEK_KEY]
    monkeypatch.setattr(s3, "put_object", put)
    assert import_week()["written"] == ([WEEK_KEY, SEASON_KEY] if key == WEEK_KEY else [SEASON_KEY])
    assert s3.objects[CSV_KEY] == CSV
    assert import_week()["written"] == []


@pytest.mark.parametrize(
    "field,value",
    [("season", None), ("season", True), ("week", None), ("week", True), ("week", 19)],
)
def test_import_requires_explicit_valid_target(setup, field, value):
    s3, _ = setup
    with pytest.raises(ValueError, match=field):
        invoke("import_picks", **{"season": 2026, "week": 6, field: value})
    assert s3.objects == {}


def test_import_uses_configured_private_prefix(setup, monkeypatch):
    s3, _ = setup
    seed_import(s3)
    monkeypatch.setenv("PBJ_INPUT_PREFIX", "private/commissioner")
    s3.objects["private/commissioner/2026/week06.csv"] = s3.objects.pop(CSV_KEY)
    assert import_week()["written"] == [WEEK_KEY, SEASON_KEY]
    assert all(key.startswith("data/") and key.endswith(".json") for key in s3.writes)


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


@pytest.mark.parametrize("picks", [True, False])
def test_manual_update_after_polling_window(setup, monkeypatch, picks):
    s3, provider = setup
    key = "data/2026/week07.json"
    data = {**weekly(), "week": 7}
    data["games"][0]["status"] = "scheduled"
    data["games"][0]["away_score"] = None
    data["games"][0]["home_score"] = None
    if not picks:
        del data["players"]
    s3.seed(key, data)
    monkeypatch.setattr(processing, "now", lambda: datetime(2026, 11, 1, tzinfo=UTC))
    assert not invoke("poll_games")["fetched"]
    provider.get_week.assert_not_called()
    s3.writes.clear()

    polling = Mock(side_effect=AssertionError("manual update must bypass should_poll"))
    monkeypatch.setattr(processing, "should_poll", polling)
    result = invoke("update_week", season=2026, week=7)
    assert result == {
        "status": "ok",
        "action": "update_week",
        "season": 2026,
        "week": 7,
        "fetched": True,
        "scored": picks,
        "written": [key, "data/2026/season.json"] if picks else [key],
    }
    provider.get_week.assert_called_once_with(season=2026, week=7)
    polling.assert_not_called()
    updated = s3.data(key)
    assert updated["games"][0]["status"] == "final"
    assert updated["games"][0]["home_score"] == 17
    assert {k: v for k, v in updated.items() if k not in ("games", "results")} == {
        k: v for k, v in data.items() if k not in ("games", "results")
    }
    season = s3.data("data/2026/season.json")
    assert season["weeks_scored"] == ([7] if picks else [])
    if picks:
        assert updated["results"]["players"][0]["wins"] == 1
        assert season["players"][0]["wins"] == 1
    s3.writes.clear()
    assert invoke("update_week", season=2026, week=7)["written"] == []
    assert s3.writes == []


def test_manual_update_targets_requested_week(setup, monkeypatch):
    s3, provider = setup
    for week in (6, 7):
        data = {**weekly(), "week": week}
        data["games"][0]["status"] = "live"
        s3.seed(f"data/2026/week{week:02d}.json", data)
    original = s3.objects["data/2026/week06.json"]
    selection = Mock(side_effect=AssertionError("manual update must bypass active selection"))
    monkeypatch.setattr(processing, "select_active_week", selection)
    assert invoke("update_week", season=2026, week=7)["week"] == 7
    provider.get_week.assert_called_once_with(season=2026, week=7)
    selection.assert_not_called()
    assert s3.objects["data/2026/week06.json"] == original


def test_manual_update_requires_existing_week(setup):
    s3, provider = setup
    s3.seed("data/2026/week06.json", weekly())
    with pytest.raises(FileNotFoundError, match="week07"):
        invoke("update_week", season=2026, week=7)
    assert "data/2026/week07.json" not in s3.objects
    assert s3.writes == []
    provider.get_week.assert_not_called()


@pytest.mark.parametrize("week", [None, True, 0, 19, "7", 7.0])
def test_manual_update_requires_valid_week(setup, week):
    s3, provider = setup
    with pytest.raises(ValueError, match="week"):
        invoke("update_week", season=2026, **({} if week is None else {"week": week}))
    assert s3.writes == []
    provider.get_week.assert_not_called()


@pytest.mark.parametrize("season", [None, True, 0, 10000, "2026", 2026.0])
def test_manual_update_requires_explicit_valid_season(setup, season):
    s3, provider = setup
    with pytest.raises(ValueError, match="season"):
        invoke("update_week", week=7, **({} if season is None else {"season": season}))
    assert s3.writes == []
    provider.get_week.assert_not_called()


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


@pytest.mark.parametrize("action", ["poll_games", "update_week"])
def test_week_conflict_never_publishes_standings(setup, action):
    s3, _ = setup
    data = weekly()
    data["games"][0]["status"] = "live"
    s3.seed("data/2026/week06.json", data)
    s3.fail = "data/2026/week06.json"
    with pytest.raises(ClientError):
        invoke(action, season=2026, week=6)
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


@pytest.mark.parametrize("action", ["poll_games", "update_week"])
def test_real_concurrent_write_rejects_stale_week(setup, action):
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
        invoke(action, season=2026, week=6)
    assert s3.data(key)["commissioner_note"] == "concurrent edit"
    assert "data/2026/season.json" not in s3.objects
    provider.get_week.side_effect = None
    invoke(action, season=2026, week=6)
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


def prepare_next(s3, monkeypatch):
    monkeypatch.setattr(processing, "now", lambda: datetime(2026, 9, 14, tzinfo=UTC))
    invoke("create_week", season=2026, week=1)
    config = storage.StorageConfig.from_environment()
    return processing.next_creation(s3, config)


def test_portal_creation_then_scheduled_publication_preserves_all_data(setup, monkeypatch):
    s3, provider = setup
    target = prepare_next(s3, monkeypatch)
    before = dict(s3.objects)
    result = invoke(
        "create_week", season=2026, week=2, publish_manifest=False, creation_token=target["token"]
    )
    assert result["written"] == ["data/2026/week02.json"]
    assert all(s3.objects[k] == value for k, value in before.items())
    created = s3.objects["data/2026/week02.json"]
    assert processing.next_creation(s3, storage.StorageConfig.from_environment()) is None
    with pytest.raises(ValueError, match="state changed"):
        invoke(
            "create_week",
            season=2026,
            week=3,
            publish_manifest=False,
            creation_token=target["token"],
        )
    assert invoke("create_week", scheduled_time="2026-09-08T12:00:00Z")["written"] == []
    result = invoke("create_week", scheduled_time="2026-09-15T12:00:00Z")
    assert result["fetched"] is False
    assert s3.objects["data/2026/week02.json"] == created
    assert s3.data("data/available-weeks.json") == {"2026": [1, 2]}
    assert provider.get_week.call_count == 2
    with pytest.raises(ValueError, match="state changed"):
        invoke(
            "create_week",
            season=2026,
            week=3,
            publish_manifest=False,
            creation_token=target["token"],
        )


@pytest.mark.parametrize(
    "public,created",
    [
        (None, [1]),
        ({"2026": [1]}, [1, 3]),
        ({"2026": [1, 2]}, [1]),
        ({"2026": []}, [1]),
        ({"2026": [True]}, [1]),
        ({"2026": [2, 1]}, [1, 2]),
        ({"2026": list(range(1, 19))}, list(range(1, 19))),
        ({"2026": [1]}, [1, 19]),
    ],
)
def test_portal_ineligible_state_fails_closed(setup, public, created):
    s3, provider = setup
    for week in created:
        s3.seed(f"data/2026/week{week:02d}.json", weekly())
    if public is not None:
        s3.seed("data/available-weeks.json", public)
    assert processing.next_creation(s3, storage.StorageConfig.from_environment()) is None
    with pytest.raises(ValueError, match="state changed"):
        invoke("create_week", season=2026, week=2, publish_manifest=False, creation_token="stale")  # noqa: S106 - catalog version
    provider.get_week.assert_not_called()
    assert s3.writes == []


def test_portal_creation_race_never_overwrites_or_publishes(setup, monkeypatch):
    s3, provider = setup
    target = prepare_next(s3, monkeypatch)
    before_manifest = s3.objects["data/available-weeks.json"]

    def race(*args, **kwargs):
        s3.seed("data/2026/week02.json", weekly())
        return provider.get_week.return_value

    provider.get_week.side_effect = race
    with pytest.raises(ClientError):
        invoke(
            "create_week",
            season=2026,
            week=2,
            publish_manifest=False,
            creation_token=target["token"],
        )
    assert s3.data("data/2026/week02.json") == weekly()
    assert s3.objects["data/available-weeks.json"] == before_manifest


def test_portal_provider_failure_preserves_state(setup, monkeypatch):
    s3, provider = setup
    target = prepare_next(s3, monkeypatch)
    before = dict(s3.objects)
    provider.get_week.side_effect = RuntimeError("Provider unavailable")
    with pytest.raises(RuntimeError, match="Provider unavailable"):
        invoke(
            "create_week",
            season=2026,
            week=2,
            publish_manifest=False,
            creation_token=target["token"],
        )
    assert s3.objects == before


@pytest.mark.parametrize("invalid", [{}, {"games": []}, {"games": [{}]}, []])
def test_portal_eligibility_does_not_read_schedule_contents(setup, invalid):
    s3, provider = setup
    s3.seed("data/2026/week01.json", invalid)
    s3.seed("data/available-weeks.json", {"2026": [1]})
    target = processing.next_creation(s3, storage.StorageConfig.from_environment())
    assert target is not None and target["week"] == 2
    provider.get_week.assert_not_called()


@pytest.mark.parametrize("option", [None, 0, "false", False])
def test_unpublished_creation_requires_valid_option_and_catalog(setup, option):
    s3, provider = setup
    with pytest.raises(ValueError):
        invoke("create_week", season=2026, week=1, publish_manifest=option)
    assert s3.writes == []
    provider.get_week.assert_not_called()


def test_portal_processor_rechecks_metadata_without_reading_weeks(setup, monkeypatch):
    from unittest.mock import MagicMock

    s3, _ = setup
    target = prepare_next(s3, monkeypatch)
    s3.get_object = MagicMock(wraps=s3.get_object)
    s3.get_paginator = MagicMock(wraps=s3.get_paginator)
    invoke(
        "create_week", season=2026, week=2, publish_manifest=False, creation_token=target["token"]
    )
    s3.get_object.assert_called_once_with(Bucket="pbj-data-jm26", Key="data/available-weeks.json")
    s3.get_paginator.assert_called_once_with("list_objects_v2")
    # Publication happened before a stale processor request reached creation.
    invoke("create_week", season=2026, week=2)
    s3.get_object.reset_mock()
    with pytest.raises(ValueError, match="state changed"):
        invoke(
            "create_week",
            season=2026,
            week=2,
            publish_manifest=False,
            creation_token=target["token"],
        )
    assert "data/2026/week03.json" not in s3.objects


def seed_portal_week(s3, week, prepared):
    for number in range(1, week + int(prepared)):
        s3.seed(f"data/2026/week{number:02d}.json", {**weekly(), "week": number})
    s3.seed("data/available-weeks.json", {"2026": list(range(1, week))})
    s3.objects[f"incoming/2026/drafts/week{week:02d}.csv"] = b"private draft"
    s3.objects[f"incoming/2026/week{week:02d}.csv"] = b"submitted picks"


@pytest.mark.parametrize(
    ("week", "release"),
    [
        (8, "2026-10-27T12:00:00+00:00"),
        (9, "2026-11-03T13:00:00+00:00"),
        (18, "2027-01-05T13:00:00+00:00"),
    ],
)
@pytest.mark.parametrize("seconds", [-1, 0, 1, 86400])
@pytest.mark.parametrize("prepared", [False, True])
def test_portal_release_boundary_and_preservation(
    setup, monkeypatch, week, release, seconds, prepared
):
    from datetime import timedelta

    s3, provider = setup
    seed_portal_week(s3, week, prepared)
    before = dict(s3.objects)
    clock = datetime.fromisoformat(release) + timedelta(seconds=seconds)
    monkeypatch.setattr(processing, "now", lambda: clock)
    config = storage.StorageConfig.from_environment()
    catalog = processing.discover_schedules(s3, config)
    assert catalog["week"] == week - 1
    assert s3.objects == before and s3.writes == []
    target = catalog["next_creation"]
    if prepared and seconds < 0:
        assert target is None
        with pytest.raises(ValueError, match="state changed"):
            invoke("create_week", week=week, publish_manifest=True, creation_token="forged")  # noqa: S106
        assert s3.objects == before and s3.writes == []
        provider.get_week.assert_not_called()
        return
    due = seconds >= 0
    assert target["action"] == ("publish" if prepared else "create")
    assert target["publish_manifest"] is due
    assert target["week"] == week
    assert datetime.fromisoformat(target["release_at"]) == datetime.fromisoformat(release)
    result = invoke("create_week", week=week, publish_manifest=due, creation_token=target["token"])
    assert result["fetched"] is not prepared
    assert result["written"] == (
        ([] if prepared else [f"data/2026/week{week:02d}.json"])
        + (["data/available-weeks.json"] if due else [])
    )
    assert provider.get_week.call_count == (0 if prepared else 1)
    assert s3.data("data/available-weeks.json") == {"2026": list(range(1, week + int(due)))}
    assert all(s3.objects[k] == v for k, v in before.items() if k != "data/available-weeks.json")
    writes = list(s3.writes)
    with pytest.raises(ValueError, match="state changed"):
        invoke("create_week", week=week, publish_manifest=due, creation_token=target["token"])
    assert s3.writes == writes


def test_portal_cutoff_invalidates_preparation_confirmation(setup, monkeypatch):
    s3, provider = setup
    seed_portal_week(s3, 9, False)
    config = storage.StorageConfig.from_environment()
    monkeypatch.setattr(processing, "now", lambda: datetime(2026, 11, 3, 12, 59, 59, tzinfo=UTC))
    early = processing.next_creation(s3, config)
    assert early is not None
    before = dict(s3.objects)
    # A valid preparation token cannot authorize early publication.
    with pytest.raises(ValueError, match="state changed"):
        invoke("create_week", week=9, publish_manifest=True, creation_token=early["token"])
    monkeypatch.setattr(processing, "now", lambda: datetime(2026, 11, 3, 13, tzinfo=UTC))
    due = processing.next_creation(s3, config)
    assert due is not None
    assert due["token"] != early["token"]
    for publish in (False, True):
        with pytest.raises(ValueError, match="state changed"):
            invoke("create_week", week=9, publish_manifest=publish, creation_token=early["token"])
    assert s3.objects == before and s3.writes == []
    provider.get_week.assert_not_called()


@pytest.mark.parametrize("season,week", [(2025, 9), (2026, 8), (2026, 10)])
def test_portal_publication_rejects_out_of_order_target(setup, monkeypatch, season, week):
    s3, provider = setup
    seed_portal_week(s3, 9, True)
    monkeypatch.setattr(processing, "now", lambda: datetime(2026, 11, 3, 13, tzinfo=UTC))
    target = processing.next_creation(s3, storage.StorageConfig.from_environment())
    assert target is not None
    before = dict(s3.objects)
    with pytest.raises(ValueError, match="state changed"):
        invoke(
            "create_week",
            season=season,
            week=week,
            publish_manifest=True,
            creation_token=target["token"],
        )
    assert s3.objects == before and s3.writes == []
    provider.get_week.assert_not_called()


@pytest.mark.parametrize("prepared", [False, True])
@pytest.mark.parametrize("code", ["PreconditionFailed", "ConditionalRequestConflict"])
def test_portal_publication_conflict_and_reconciliation(setup, monkeypatch, prepared, code):
    s3, provider = setup
    seed_portal_week(s3, 9, prepared)
    monkeypatch.setattr(processing, "now", lambda: datetime(2026, 11, 3, 13, tzinfo=UTC))
    config = storage.StorageConfig.from_environment()
    target = processing.next_creation(s3, config)
    assert target is not None
    before = dict(s3.objects)
    put = s3.put_object

    def conflict(**kwargs):
        if kwargs["Key"] == "data/available-weeks.json":
            raise error(code)
        return put(**kwargs)

    monkeypatch.setattr(s3, "put_object", conflict)
    with pytest.raises(ClientError):
        invoke("create_week", week=9, publish_manifest=True, creation_token=target["token"])
    assert all(s3.objects[k] == v for k, v in before.items())
    created = s3.objects["data/2026/week09.json"]
    retry = processing.next_creation(s3, config)
    assert retry is not None
    assert retry["action"] == "publish"
    monkeypatch.setattr(s3, "put_object", put)
    result = invoke("create_week", week=9, publish_manifest=True, creation_token=retry["token"])
    assert result["written"] == ["data/available-weeks.json"]
    assert s3.objects["data/2026/week09.json"] == created
    assert provider.get_week.call_count == (0 if prepared else 1)


def test_portal_manifest_write_uses_authorized_snapshot(setup, monkeypatch):
    s3, provider = setup
    seed_portal_week(s3, 9, False)
    monkeypatch.setattr(processing, "now", lambda: datetime(2026, 11, 3, 13, tzinfo=UTC))
    target = processing.next_creation(s3, storage.StorageConfig.from_environment())
    assert target is not None
    concurrent = json.dumps({"2026": list(range(1, 9))}, indent=4).encode()

    def race(*args, **kwargs):
        s3.objects["data/available-weeks.json"] = concurrent
        return provider.get_week.return_value

    provider.get_week.side_effect = race
    with pytest.raises(ClientError):
        invoke("create_week", week=9, publish_manifest=True, creation_token=target["token"])
    assert s3.objects["data/available-weeks.json"] == concurrent
    assert s3.writes == ["data/2026/week09.json"]


def test_portal_recovery_uses_configured_season_and_tuesday(setup, monkeypatch):
    s3, _ = setup
    seed_portal_week(s3, 9, True)
    config = storage.StorageConfig.from_environment()
    monkeypatch.setenv("PBJ_SEASON", "2027")
    assert processing.next_creation(s3, config) is None
    monkeypatch.setenv("PBJ_SEASON", "2026")
    monkeypatch.setenv("PBJ_WEEK1_CREATION_DATE", "2026-09-09")
    assert processing.next_creation(s3, config) is None


@pytest.mark.parametrize(
    "event",
    [
        {"publish_manifest": True, "creation_token": ""},
        {"publish_manifest": True, "creation_token": 1},
        {"creation_token": "token"},
        {
            "publish_manifest": True,
            "creation_token": "token",
            "scheduled_time": "2026-11-03T13:00:00Z",
        },
    ],
)
def test_invalid_portal_publication_event_never_calls_aws(setup, monkeypatch, event):
    client = Mock()
    monkeypatch.setattr(storage, "client", client)
    with pytest.raises(ValueError):
        invoke("create_week", **({} if "scheduled_time" in event else {"week": 9}), **event)
    client.assert_not_called()


@pytest.mark.parametrize(
    ("scenario", "gets", "puts", "aggregations"),
    [
        ("idle", 7, 1, 1),
        ("completed", 7, 1, 1),
        ("live", 8, 2, 1),
        ("correction", 8, 2, 1),
        ("recovery", 7, 1, 1),
        ("creation", 1, 2, 0),
        ("delayed", 1, 1, 0),
    ],
)
def test_processing_operation_budget(
    setup, monkeypatch, tmp_path, scenario, gets, puts, aggregations
):
    """Keep recovery work explicit while measuring a six-week offline S3 season."""
    from scripts import aggregate_season, score_week

    s3, provider = setup
    for week in range(1, 7):
        data = {**weekly(), "week": week}
        path = tmp_path / f"week{week:02d}.json"
        path.write_text(json.dumps(data))
        score_week.score_week_file(path, 2026, week)
        s3.objects[f"data/2026/{path.name}"] = path.read_bytes()
    aggregate_season.aggregate_season_files(2026, tmp_path)
    s3.objects[SEASON_KEY] = (tmp_path / "season.json").read_bytes()
    if scenario in ("idle", "live"):
        data = s3.data(WEEK_KEY)
        data["games"][0]["status"] = "scheduled" if scenario == "idle" else "live"
        if scenario == "idle":
            data["games"][0]["scheduled_time"] = "2026-10-25T17:00:00+00:00"
        else:
            from dataclasses import replace

            provider.get_week.return_value = [
                replace(provider.get_week.return_value[0], away_score=20)
            ]
        s3.seed(WEEK_KEY, data)
    if scenario == "correction":
        s3.objects[CSV_KEY] = CSV
    if scenario == "recovery":
        # The week write succeeded previously; its season publication did not.
        s3.seed(SEASON_KEY, {"season": 2026, "weeks_scored": [], "players": []})
    if scenario == "delayed":
        s3.seed("data/available-weeks.json", {"2026": [1, 2, 3, 4, 5]})
    listing = Mock(wraps=s3.paginate)
    reading = Mock(wraps=s3.get_object)
    writing = Mock(wraps=s3.put_object)
    aggregation = Mock(wraps=aggregate_season.aggregate_season_files)
    monkeypatch.setattr(s3, "paginate", listing)
    monkeypatch.setattr(s3, "get_object", reading)
    monkeypatch.setattr(s3, "put_object", writing)
    monkeypatch.setattr(aggregate_season, "aggregate_season_files", aggregation)
    if scenario == "correction":
        import_week()
    elif scenario in ("creation", "delayed"):
        invoke("create_week", week=7 if scenario == "creation" else 6)
    else:
        invoke("poll_games")
    counts = (listing.call_count, reading.call_count, writing.call_count, aggregation.call_count)
    print(f"{scenario}: list/get/put/aggregate={counts}")
    assert counts == (1, gets, puts, aggregations)
    week_reads = sum(
        call.kwargs["Key"].endswith(".json") and "/week" in call.kwargs["Key"]
        for call in reading.call_args_list
    )
    assert week_reads == (
        0 if scenario in ("creation", "delayed") else 7 if scenario == "live" else 6
    )
    if scenario == "recovery":
        assert s3.data(SEASON_KEY)["weeks_scored"] == list(range(1, 7))


@pytest.mark.parametrize(
    ("count", "state"),
    [
        (2, "scheduled"),
        (9, "scheduled"),
        (18, "scheduled"),
        (18, "completed"),
        (18, "live"),
        (18, "empty"),
    ],
)
def test_warm_poll_budget_and_equivalence(setup, monkeypatch, tmp_path, count, state):
    from pbj.active_week import select_active_week
    from scripts import aggregate_season, score_week

    s3, provider = setup
    weeks = {}
    for week in range(1, count + 1):
        data = {**weekly(), "week": week}
        if week == count:
            if state == "empty":
                data["games"] = []
                data.pop("players", None)
            elif state != "completed":
                data["games"][0]["status"] = state
                data["games"][0]["scheduled_time"] = "2026-10-25T17:00:00+00:00"
        path = tmp_path / f"week{week:02d}.json"
        path.write_text(json.dumps(data))
        if data.get("players"):
            score_week.score_week_file(path, 2026, week)
        s3.objects[f"data/2026/{path.name}"] = path.read_bytes()
        weeks[week] = load_games(path)
    aggregate_season.aggregate_season_files(2026, tmp_path)
    expected = json.loads((tmp_path / "season.json").read_bytes())
    if state == "live":
        provider.get_week.return_value = weeks[count]
    reading = Mock(wraps=s3.get_object)
    aggregation = Mock(wraps=aggregate_season.aggregate_season_files)
    monkeypatch.setattr(s3, "get_object", reading)
    monkeypatch.setattr(aggregate_season, "aggregate_season_files", aggregation)
    cold = invoke("poll_games")
    assert cold["week"] == select_active_week(weeks)
    assert s3.data(SEASON_KEY) == expected
    assert reading.call_count == count + 1
    reading.reset_mock()
    aggregation.reset_mock()
    provider.reset_mock()
    before = s3.objects.copy()
    result = invoke("poll_games")
    assert result["week"] == cold["week"]
    assert result["written"] == []
    assert not result["scored"]
    assert result["fetched"] == (state == "live")
    assert reading.call_count == (2 if state in ("scheduled", "live") else 1)
    aggregation.assert_not_called()
    assert s3.objects == before


@pytest.mark.parametrize("damage", ["malformed", "listing"])
def test_poll_unusable_metadata_requires_reconciliation(setup, monkeypatch, damage):
    from scripts import aggregate_season

    s3, _ = setup
    s3.seed(WEEK_KEY, weekly())
    invoke("poll_games")
    expected = s3.data(SEASON_KEY)
    if damage == "malformed":
        s3.metadata[SEASON_KEY] = {processing.POLL_SOURCES: "["}
    else:
        paginate = s3.paginate

        def without_etags(**kwargs):
            return [
                {"Contents": [{"Key": item["Key"]} for item in page["Contents"]]}
                for page in paginate(**kwargs)
            ]

        monkeypatch.setattr(s3, "paginate", without_etags)
    aggregate = Mock(wraps=aggregate_season.aggregate_season_files)
    monkeypatch.setattr(aggregate_season, "aggregate_season_files", aggregate)
    assert not invoke("poll_games")["fetched"]
    aggregate.assert_called_once()
    assert s3.data(SEASON_KEY) == expected


@pytest.mark.parametrize("failure", ["paginate", "get_object"])
def test_poll_read_and_listing_failures_propagate(setup, monkeypatch, failure):
    s3, _ = setup
    s3.seed(WEEK_KEY, weekly())
    monkeypatch.setattr(s3, failure, Mock(side_effect=error("AccessDenied")))
    with pytest.raises(ClientError, match="AccessDenied"):
        invoke("poll_games")


def test_warm_poll_postponed_week_precedes_prepared_future(setup, monkeypatch):
    s3, provider = setup
    for week in (5, 6, 7):
        data = {**weekly(), "week": week}
        if week in (5, 7):
            data["games"][0]["status"] = "scheduled"
            data["games"][0]["scheduled_time"] = "2026-11-01T17:00:00+00:00"
        s3.seed(f"data/2026/week{week:02d}.json", data)
    s3.seed("data/available-weeks.json", {"2026": [5, 6]})
    invoke("poll_games")
    monkeypatch.setattr(processing, "now", lambda: datetime(2026, 11, 1, 17, tzinfo=UTC))
    result = invoke("poll_games")
    assert result["week"] == 5
    provider.get_week.assert_called_once_with(season=2026, week=5)
    assert s3.data("data/available-weeks.json") == {"2026": [5, 6]}


def test_warm_partial_publication_recovery_budget(setup, monkeypatch):
    from scripts import aggregate_season

    s3, provider = setup
    for week in range(1, 10):
        data = {**weekly(), "week": week}
        if week == 9:
            data["games"][0]["status"] = "scheduled"
            data["games"][0]["scheduled_time"] = "2026-10-25T17:00:00+00:00"
        s3.seed(f"data/2026/week{week:02d}.json", data)
    invoke("poll_games")
    monkeypatch.setattr(processing, "now", lambda: datetime(2026, 10, 25, 17, tzinfo=UTC))
    old_metadata = s3.metadata[SEASON_KEY].copy()
    s3.fail = SEASON_KEY
    with pytest.raises(ClientError):
        invoke("poll_games")
    assert s3.metadata[SEASON_KEY] == old_metadata
    assert s3.data("data/2026/week09.json")["games"][0]["status"] == "final"
    s3.fail = None
    reading = Mock(wraps=s3.get_object)
    aggregation = Mock(wraps=aggregate_season.aggregate_season_files)
    monkeypatch.setattr(s3, "get_object", reading)
    monkeypatch.setattr(aggregate_season, "aggregate_season_files", aggregation)
    result = invoke("poll_games")
    assert not result["fetched"] and not result["scored"]
    assert result["written"] == [SEASON_KEY]
    assert s3.data(SEASON_KEY)["weeks_scored"] == [9]
    assert s3.data(SEASON_KEY)["players"]
    assert reading.call_count == 10
    aggregation.assert_called_once()
    provider.get_week.assert_called_once()
    reading.reset_mock()
    aggregation.reset_mock()
    assert invoke("poll_games")["written"] == []
    assert reading.call_count == 1
    aggregation.assert_not_called()
