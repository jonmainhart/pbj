"""Commissioner CSV validation contracts."""

import json
from datetime import UTC, datetime
from io import BytesIO, StringIO
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import boto3
import pytest
from botocore.exceptions import ClientError

from aws import admin, storage
from aws.admin_csv import inspect_csv
from pbj.importers.numbers import import_players
from pbj.week_data import load_games


def test_empty_headers_follow_schedule():
    games = load_games(Path("data/2026/week01.json"))
    result = inspect_csv("", games)
    assert result["headers"][0] == "NAME"
    assert result["headers"][-1] == "TIEBREAKER"
    assert len(result["headers"]) == len(games) + 2
    assert result["rows"] == []


def test_correctable_cells_and_duplicate_ids():
    games = load_games(Path("data/2026/week01.json"))[:1]
    result = inspect_csv("NAME,NE SEA,TIEBREAKER\nJosé,BAD,nan\nJose,N/P,3\n", games)
    assert {issue["column"] for issue in result["issues"]} >= {0, 1, 2}
    assert any(issue["severity"] == "warning" for issue in result["issues"])
    assert len(result["rows"]) == 2


def test_aliases_and_importer_compatibility():
    games = load_games(Path("data/2026/week01.json"))[:1]
    result = inspect_csv("Title\nNAME,NE SEA,TIEBREAKER,CORRECT\nAlice,SEA,30,0\n", games)
    assert not [issue for issue in result["issues"] if issue["severity"] == "error"]
    assert import_players(StringIO(result["csv"]), games)[0].name == "Alice"


def test_missing_schedule_columns_and_malformed_rows():
    games = load_games(Path("data/2026/week01.json"))[:1]
    result = inspect_csv("NAME,BOGUS,TIEBREAKER\nAlice,SEA,30,extra\n", games)
    assert len(result["issues"]) >= 2


def event(path="/weeks/2026/1", method="GET", **body):
    return dict(
        rawPath=path,
        requestContext=dict(
            http=dict(method=method),
            authorizer=dict(
                jwt=dict(
                    claims=dict(
                        sub="commissioner",
                        token_use="access",  # noqa: S106 - OAuth token type
                        scope="pbj/admin",
                        client_id="spa",
                    )
                )
            ),
        ),
        body=json.dumps(body),
    )


def setup_api(monkeypatch):
    monkeypatch.setenv("PBJ_DATA_BUCKET", "private")
    monkeypatch.setenv("PBJ_DATA_PREFIX", "data/")
    monkeypatch.setenv("PBJ_ADMIN_CLIENT_ID", "spa")
    monkeypatch.setenv("PBJ_PROCESSOR_FUNCTION", "pbj-processor")
    client = MagicMock()
    monkeypatch.setattr(storage, "client", lambda: client)
    schedule = storage.Snapshot(Path("data/2026/week01.json").read_bytes(), "schedule")
    monkeypatch.setattr(
        storage, "read", lambda s, c, k, **kw: schedule if k.endswith(".json") else None
    )
    client.put_object.return_value = {"ETag": "new-version"}
    return client


@pytest.mark.smoke
def test_authorization_fails_closed(monkeypatch):
    monkeypatch.setenv("PBJ_ADMIN_CLIENT_ID", "spa")
    client = MagicMock(side_effect=AssertionError("Unauthorized request accessed S3"))
    monkeypatch.setattr(storage, "client", client)
    assert admin.lambda_handler({}, None)["statusCode"] == 403
    for claim, value in [("token_use", "id"), ("scope", "openid"), ("client_id", "other")]:
        request = event()
        request["requestContext"]["authorizer"]["jwt"]["claims"][claim] = value
        assert admin.lambda_handler(request, None)["statusCode"] == 403
    client.assert_not_called()


def test_draft_save_uses_conditional_private_csv(monkeypatch):
    client = setup_api(monkeypatch)
    request = event("/weeks/2026/1/draft", "PUT", csv="invalid editable data", etag="old")
    result = admin.lambda_handler(request, None)
    assert result["statusCode"] == 200
    call = client.put_object.call_args.kwargs
    assert call["Key"] == "incoming/2026/drafts/week01.csv"
    assert call["IfMatch"] == "old"
    assert call["Body"] == b"invalid editable data"


def test_concurrent_save_is_conflict(monkeypatch):
    client = setup_api(monkeypatch)
    client.put_object.side_effect = ClientError(
        {"Error": {"Code": "PreconditionFailed"}}, "PutObject"
    )
    result = admin.lambda_handler(event("/weeks/2026/1/draft", "PUT", csv=""), None)
    assert result["statusCode"] == 409


@pytest.mark.parametrize("code", ["PreconditionFailed", "ConditionalRequestConflict"])
@pytest.mark.parametrize(
    ("path", "method", "message"),
    [
        (
            "/schedules/next",
            "POST",
            "Schedule state changed. Refresh the catalog before trying again.",
        ),
        (
            "/weeks/2026/1/draft",
            "PUT",
            "Draft changed in another session. Reopen before saving.",
        ),
    ],
)
def test_conditional_conflict_message_matches_operation(monkeypatch, code, path, method, message):
    monkeypatch.setenv("PBJ_ADMIN_CLIENT_ID", "spa")
    dispatch = MagicMock(side_effect=ClientError({"Error": {"Code": code}}, "PutObject"))
    monkeypatch.setattr(admin, "dispatch", dispatch)
    request = event(path, method)
    result = admin.lambda_handler(request, None)
    assert result["statusCode"] == 409
    assert json.loads(result["body"]) == {"message": message}
    dispatch.assert_called_once_with(request)


@pytest.mark.smoke
def test_submission_blocks_invalid_and_empty(monkeypatch):
    client, schedule, _ = published_week(monkeypatch, players=[])
    assert (schedule["season"], schedule["week"]) == (2026, 1)
    for text in ["", "NAME,TIEBREAKER\nAlice,nan\n"]:
        result = admin.lambda_handler(
            event("/weeks/2026/1/submit", "POST", csv=text, confirm=True), None
        )
        assert result["statusCode"] == 422
        body = json.loads(result["body"])
        assert body["message"] == "Confirm submission and correct all errors"
        if text:
            assert body["rows"] == [["Alice", "nan"]]
            assert {
                "row": 0,
                "column": 1,
                "severity": "error",
                "message": "Tiebreaker must be a finite nonnegative number",
            } in body["issues"]
        else:
            assert body["rows"] == []
            assert body["issues"] == []
    client.put_object.assert_not_called()


def valid_csv():
    games = load_games(Path("data/2026/week01.json"))
    headers = inspect_csv("", games)["headers"]
    return ",".join(headers) + "\nAlice," + ",".join(g.home.abbreviation for g in games) + ",30\n"


def test_submit_reports_actual_processor_result(monkeypatch):
    client = setup_api(monkeypatch)
    processor = MagicMock()
    monkeypatch.setattr(boto3, "client", lambda service, **kwargs: processor)
    processor.invoke.return_value = {
        "Payload": BytesIO(b'{"status":"ok","written":["data/2026/week01.json"]}')
    }
    result = admin.lambda_handler(
        event(
            "/weeks/2026/1/submit",
            "POST",
            csv=valid_csv(),
            confirm=True,
            acknowledge_published=True,
        ),
        None,
    )
    assert result["statusCode"] == 200
    assert json.loads(result["body"])["result"]["written"] == ["data/2026/week01.json"]
    assert client.put_object.call_args.kwargs["Metadata"]["state"] == "complete"
    payload = json.loads(processor.invoke.call_args.kwargs["Payload"])
    assert payload == dict(action="import_picks", season=2026, week=1)


def test_processor_failure_retains_pending_input_and_draft(monkeypatch):
    client = setup_api(monkeypatch)
    processor = MagicMock()
    monkeypatch.setattr(boto3, "client", lambda service, **kwargs: processor)
    processor.invoke.return_value = {"FunctionError": "Unhandled", "Payload": BytesIO(b"{}")}
    result = admin.lambda_handler(
        event(
            "/weeks/2026/1/submit",
            "POST",
            csv=valid_csv(),
            confirm=True,
            acknowledge_published=True,
        ),
        None,
    )
    assert result["statusCode"] == 502
    assert client.put_object.call_args.kwargs["Metadata"]["state"] == "pending"
    assert json.loads(result["body"])["etag"] == "new-version"


@pytest.mark.parametrize("count", [1, 8, 18])
@pytest.mark.parametrize("prefix", ["data/", "archive/pbj/"])
def test_schedule_catalog_uses_one_listing_and_only_the_manifest(monkeypatch, count, prefix):
    s3, _, _ = creation_api(monkeypatch)
    monkeypatch.setenv("PBJ_DATA_PREFIX", prefix)
    s3.objects.clear()
    public = {"2025": list(range(1, 19)), "2026": list(range(1, count + 1))}
    for season, weeks in public.items():
        for week in weeks:
            # Discovery must not parse even malformed historical documents.
            s3.objects[f"{prefix}{season}/week{week:02d}.json"] = b"malformed weekly JSON"
    s3.seed(prefix + "available-weeks.json", public)
    s3.get_paginator = MagicMock(wraps=s3.get_paginator)
    s3.get_object = MagicMock(wraps=s3.get_object)
    result = admin.lambda_handler(event("/schedules"), None)
    assert result["statusCode"] == 200
    catalog = json.loads(result["body"])
    assert catalog["seasons"] == public
    assert (catalog["season"], catalog["week"]) == (2026, count)
    assert catalog["user_id"] == "commissioner"
    assert (catalog["next_creation"] is None) == (count == 18)
    if count < 18:
        assert catalog["next_creation"]["week"] == count + 1
    s3.get_paginator.assert_called_once_with("list_objects_v2")
    s3.get_object.assert_called_once_with(
        Bucket="pbj-data-jm26", Key=prefix + "available-weeks.json"
    )


@pytest.mark.parametrize("latest", [2, 18])
def test_unpublished_week_is_selectable_but_not_the_default(monkeypatch, latest):
    s3, _, _ = creation_api(monkeypatch)
    for week in range(2, latest + 1):
        s3.objects[f"data/2026/week{week:02d}.json"] = b"not read during discovery"
    s3.seed("data/available-weeks.json", {"2026": list(range(1, latest))})
    result = admin.lambda_handler(event("/schedules"), None)
    assert result["statusCode"] == 200
    catalog = json.loads(result["body"])
    assert catalog["seasons"] == {"2026": list(range(1, latest + 1))}
    assert catalog["week"] == latest - 1
    assert catalog["next_creation"] is None


def test_explicit_missing_schedule_is_not_substituted(monkeypatch):
    setup_api(monkeypatch)

    def missing(*args, **kwargs):
        raise ClientError({"Error": {"Code": "NoSuchKey"}}, "GetObject")

    monkeypatch.setattr(storage, "read", missing)
    assert admin.lambda_handler(event("/weeks/2026/18"), None)["statusCode"] == 404


def test_pending_submission_cannot_be_replaced(monkeypatch):
    client = setup_api(monkeypatch)
    original_read = storage.read

    def read(s3, config, key, **kwargs):
        if key.endswith(".csv") and "/drafts/" not in key:
            return storage.Snapshot(b"previous input", "previous")
        return original_read(s3, config, key, **kwargs)

    monkeypatch.setattr(storage, "read", read)
    client.head_object.return_value = {"Metadata": {"state": "pending"}}
    result = admin.lambda_handler(
        event(
            "/weeks/2026/1/submit",
            "POST",
            csv=valid_csv(),
            confirm=True,
            acknowledge_published=True,
        ),
        None,
    )
    assert result["statusCode"] == 409
    assert all("/drafts/" in call.kwargs["Key"] for call in client.put_object.call_args_list)


def test_draft_reopens_csv_with_version(monkeypatch):
    setup_api(monkeypatch)
    original_read = storage.read
    monkeypatch.setattr(
        storage,
        "read",
        lambda s, c, k, **kw: (
            storage.Snapshot(valid_csv().encode(), "saved-version")
            if "/drafts/" in k
            else original_read(s, c, k, **kw)
        ),
    )
    body = json.loads(admin.lambda_handler(event(), None)["body"])
    assert body["etag"] == "saved-version"
    assert body["rows"][0][0] == "Alice"


def test_matchup_aliases_match_existing_importer():
    from dataclasses import replace

    game = load_games(Path("data/2026/week01.json"))[0]
    game = replace(
        game,
        away=replace(game.away, abbreviation="JAX"),
        home=replace(game.home, abbreviation="WSH"),
    )
    result = inspect_csv("NAME,JAC WAS,TIEBREAKER\nAlice,WAS,3\n", [game])
    assert result["issues"] == []
    assert import_players(StringIO(result["csv"]), [game])[0].picks[game.id] == "WSH"


def test_open_week_reads_s3_draft_and_distinguishes_errors(monkeypatch):
    """Exercise actual storage.read instead of mocking missing files as None."""
    real_read = storage.read
    client = setup_api(monkeypatch)
    monkeypatch.setattr(storage, "read", real_read)
    raw = json.loads(Path("data/2026/week01.json").read_text())
    raw["players"] = []
    schedule = json.dumps(raw).encode()
    games = load_games(Path("data/2026/week01.json"))
    expected_headers = [
        "NAME",
        *[f"{g.away.abbreviation} {g.home.abbreviation}" for g in games],
        "TIEBREAKER",
    ]
    draft_key = "incoming/2026/drafts/week01.csv"

    def read_case(error=None, draft=None, listed=None, list_error=None):
        def get_object(**kwargs):
            if kwargs["Key"].endswith(".json"):
                return {"Body": BytesIO(schedule), "ETag": "schedule"}
            assert kwargs["Key"] == draft_key
            if error:
                raise ClientError({"Error": {"Code": error}}, "GetObject")
            return {"Body": BytesIO(draft.encode()), "ETag": "draft-version"}

        client.get_object.side_effect = get_object
        client.list_objects_v2.reset_mock()
        client.list_objects_v2.return_value = {"Contents": [{"Key": k} for k in listed or []]}
        client.list_objects_v2.side_effect = (
            ClientError({"Error": {"Code": list_error}}, "ListObjectsV2") if list_error else None
        )
        result = admin.lambda_handler(event(), None)
        return result["statusCode"], json.loads(result["body"])

    status, body = read_case(error="NoSuchKey")
    assert status == 200
    assert body["headers"] == expected_headers
    assert body["rows"] == []
    assert body["etag"] is None
    client.list_objects_v2.assert_not_called()

    status, body = read_case(draft=valid_csv())
    assert status == 200
    assert body["headers"] == expected_headers
    assert body["rows"][0][0] == "Alice"
    assert body["etag"] == "draft-version"
    client.list_objects_v2.assert_not_called()

    # Prefix-scoped ListBucket may leave GetObject returning 403 for absent keys.
    status, body = read_case(error="AccessDenied", listed=[draft_key + ".backup"])
    assert status == 200
    assert body["headers"] == expected_headers
    assert body["rows"] == []
    assert body["etag"] is None
    client.list_objects_v2.assert_called_once_with(Bucket="private", Prefix=draft_key, MaxKeys=1)

    for kwargs in (
        dict(error="AccessDenied", listed=[draft_key]),
        dict(error="AccessDenied", list_error="AccessDenied"),
        dict(error="InternalError"),
    ):
        status, body = read_case(**kwargs)
        assert status == 502
        assert "rows" not in body
        assert "AWS operation failed" in body["message"]
    client.list_objects_v2.assert_not_called()


def test_private_listing_permission_is_limited_to_csv_key_patterns():
    import re

    config = Path("aws/terraform/admin.tf").read_text()
    statement = re.split(r'Sid\s*=\s*"PrivateCSVExistence"', config, maxsplit=1)[1].split(
        "\n      },", 1
    )[0]
    assert 'Action   = "s3:ListBucket"' in statement
    assert 'Resource = "arn:aws:s3:::${local.data_bucket}"' in statement
    prefixes = re.findall(r'"(incoming/[^\"]+)"', statement)
    assert prefixes == ["incoming/????/drafts/week??.csv", "incoming/????/week??.csv"]
    # Existing read/write grants stay scoped to these same two private CSV paths.
    assert (
        'Resource = ["arn:aws:s3:::${local.data_bucket}/incoming/????/drafts/week??.csv", '
        '"arn:aws:s3:::${local.data_bucket}/incoming/????/week??.csv"]' in config
    )


def test_verified_identity_and_schedule_orientation_are_exposed(monkeypatch):
    s3, _, _ = creation_api(monkeypatch)
    s3.objects["data/2026/week01.json"] = Path("data/2026/week01.json").read_bytes()
    catalog = json.loads(admin.lambda_handler(event("/schedules"), None)["body"])
    assert catalog["user_id"] == "commissioner"
    body = json.loads(admin.lambda_handler(event(), None)["body"])
    games = load_games(Path("data/2026/week01.json"))
    assert body["games"] == [
        dict(id=g.id, away=g.away.abbreviation, home=g.home.abbreviation) for g in games
    ]
    request = event("/schedules")
    del request["requestContext"]["authorizer"]["jwt"]["claims"]["sub"]
    rejected = admin.lambda_handler(request, None)
    assert rejected["statusCode"] == 403
    assert "user_id" not in json.loads(rejected["body"])


def test_reversed_matchup_csv_preserves_game_association():
    games = load_games(Path("data/2026/week01.json"))[:1]
    game = games[0]
    text = (
        f"NAME,{game.home.abbreviation} {game.away.abbreviation},TIEBREAKER\n"
        f"Alice,{game.away.abbreviation},30\n"
    )
    result = inspect_csv(text, games)
    assert result["issues"] == []
    assert import_players(StringIO(result["csv"]), games)[0].picks == {
        game.id: game.away.abbreviation
    }


def published_week(monkeypatch, players=None, draft=None):
    client = setup_api(monkeypatch)
    raw = json.loads(Path("data/2026/week01.json").read_text())
    games = load_games(Path("data/2026/week01.json"))
    raw["players"] = (
        players
        if players is not None
        else [
            dict(
                name='Zoë, "Coach"',
                picks={g.id: g.home.abbreviation for g in reversed(games)},
                tiebreaker=42.5,
            ),
            dict(name="Alice", picks={}, tiebreaker=0),
        ]
    )
    monkeypatch.setattr(
        storage,
        "read",
        lambda s, c, k, **kw: (
            storage.Snapshot(json.dumps(raw).encode(), "published")
            if k.endswith(".json")
            else draft
        ),
    )
    return client, raw, games


def test_published_picks_round_trip_without_writes(monkeypatch):
    client, raw, games = published_week(monkeypatch)
    result = admin.lambda_handler(event(), None)
    assert result["statusCode"] == 200
    body = json.loads(result["body"])
    assert body["etag"] is None
    assert body["headers"] == inspect_csv("", games)["headers"]
    assert [row[0] for row in body["rows"]] == [p["name"] for p in raw["players"]]
    assert body["rows"][0][1:-1] == [g.home.abbreviation for g in games]
    assert body["rows"][1][1:-1] == ["N/P"] * len(games)
    assert not any(i["severity"] == "error" for i in body["issues"])
    players = import_players(StringIO(body["csv"]), games)
    assert [(p.name, p.picks, p.tiebreaker) for p in players] == [
        (p["name"], p["picks"], p["tiebreaker"]) for p in raw["players"]
    ]
    client.put_object.assert_not_called()
    saved = admin.lambda_handler(
        event("/weeks/2026/1/draft", "PUT", csv=body["csv"], etag=body["etag"]), None
    )
    assert saved["statusCode"] == 200
    assert client.put_object.call_args.kwargs["IfNoneMatch"] == "*"
    assert "IfMatch" not in client.put_object.call_args.kwargs
    client.put_object.side_effect = ClientError(
        {"Error": {"Code": "PreconditionFailed"}}, "PutObject"
    )
    assert (
        admin.lambda_handler(event("/weeks/2026/1/draft", "PUT", csv=body["csv"], etag=None), None)[
            "statusCode"
        ]
        == 409
    )


def test_existing_drafts_override_published_players_even_empty_or_invalid(monkeypatch):
    for text in ("", "NAME,NE SEA,TIEBREAKER\nPartial,\n", valid_csv()):
        client, _, games = published_week(
            monkeypatch, draft=storage.Snapshot(text.encode(), "draft")
        )
        body = json.loads(admin.lambda_handler(event(), None)["body"])
        assert body["etag"] == "draft"
        assert {k: body[k] for k in ("headers", "rows", "csv", "issues")} == inspect_csv(
            text, games
        )
        client.put_object.assert_not_called()


def test_no_published_players_stays_blank(monkeypatch):
    client, _, games = published_week(monkeypatch, players=[])
    body = json.loads(admin.lambda_handler(event(), None)["body"])
    assert body["rows"] == []
    assert body["headers"] == inspect_csv("", games)["headers"]
    assert body["etag"] is None
    client.put_object.assert_not_called()


def test_malformed_published_players_return_useful_error(monkeypatch):
    game_id = load_games(Path("data/2026/week01.json"))[0].id
    cases: list[Any] = [
        None,
        {},
        [None],
        [dict(name="Alice", picks={game_id: None}, tiebreaker=3)],
        [dict(name="Alice", picks={}, tiebreaker=3)] * 2,
        [dict(name="Alice", picks={}, tiebreaker=3), None],
        [dict(name="", picks={}, tiebreaker=3)],
        [dict(name="Alice", picks=[], tiebreaker=3)],
        [dict(name="Alice", picks={"unknown": "SEA"}, tiebreaker=3)],
        [dict(name="Alice", picks={}, tiebreaker=None)],
        [dict(name="Alice", picks={}, tiebreaker=True)],
        [dict(name="Alice", picks={}, tiebreaker=float("inf"))],
    ]
    for players in cases:
        client, raw, _ = published_week(monkeypatch)
        raw["players"] = players
        monkeypatch.setattr(
            storage,
            "read",
            lambda s, c, k, raw=raw, **kw: (
                storage.Snapshot(json.dumps(raw).encode(), "published")
                if k.endswith(".json")
                else None
            ),
        )
        result = admin.lambda_handler(event(), None)
        assert result["statusCode"] == 400
        assert "published" in json.loads(result["body"])["message"].lower()
        client.put_object.assert_not_called()


def test_existing_fixture_players_follow_reordered_schedule(monkeypatch):
    client = setup_api(monkeypatch)
    raw = json.loads(Path("data/2026/week01.json").read_text())
    raw["games"].reverse()
    monkeypatch.setattr(
        storage,
        "read",
        lambda s, c, k, **kw: (
            storage.Snapshot(json.dumps(raw).encode(), "published") if k.endswith(".json") else None
        ),
    )
    result = admin.lambda_handler(event(), None)
    assert result["statusCode"] == 200
    body = json.loads(result["body"])
    games = list(reversed(load_games(Path("data/2026/week01.json"))))
    assert body["headers"] == inspect_csv("", games)["headers"]
    players = import_players(StringIO(body["csv"]), games)
    assert [(p.name, p.picks, p.tiebreaker) for p in players] == [
        (p["name"], p["picks"], p["tiebreaker"]) for p in raw["players"]
    ]
    client.put_object.assert_not_called()


def test_week_source_and_publication_are_independent(monkeypatch):
    cases: list[tuple[Any, storage.Snapshot | None, str, bool]] = [
        ([], None, "empty", False),
        (None, None, "published", True),
        (None, storage.Snapshot(b"", "draft"), "draft", True),
        ([], storage.Snapshot(b"", "draft"), "draft", False),
    ]
    for players, draft, source, published in cases:
        published_week(monkeypatch, players=players, draft=draft)
        body = json.loads(admin.lambda_handler(event(), None)["body"])
        assert body["source"] == source
        assert body["published"] is published


def test_published_submission_requires_separate_acknowledgement(monkeypatch):
    client, _, _ = published_week(monkeypatch)
    for acknowledgement in [None, False, "true"]:
        result = admin.lambda_handler(
            event(
                "/weeks/2026/1/submit",
                "POST",
                csv=valid_csv(),
                confirm=True,
                acknowledge_published=acknowledgement,
                published=False,
            ),
            None,
        )
        assert result["statusCode"] == 422
    client.put_object.assert_not_called()
    processor = MagicMock()
    monkeypatch.setattr(boto3, "client", lambda *a, **kw: processor)
    processor.invoke.return_value = {"Payload": BytesIO(b'{"status":"ok"}')}
    assert (
        admin.lambda_handler(
            event(
                "/weeks/2026/1/submit",
                "POST",
                csv=valid_csv(),
                confirm=True,
                acknowledge_published=True,
            ),
            None,
        )["statusCode"]
        == 200
    )


def test_delete_requires_existing_exact_version_and_only_deletes_draft(monkeypatch):
    client, _, _ = published_week(monkeypatch, draft=storage.Snapshot(b"", "draft"))
    for etag, expected in [(None, 400), ("*", 400), ("stale", 409), ("draft", 200)]:
        result = admin.lambda_handler(event("/weeks/2026/1/draft", "DELETE", etag=etag), None)
        assert result["statusCode"] == expected
    client.delete_object.assert_called_once_with(
        Bucket="private", Key="incoming/2026/drafts/week01.csv", IfMatch="draft"
    )
    client.put_object.assert_not_called()
    client, _, _ = published_week(monkeypatch)
    assert (
        admin.lambda_handler(event("/weeks/2026/1/draft", "DELETE", etag="draft"), None)[
            "statusCode"
        ]
        == 404
    )
    client.delete_object.assert_not_called()


def test_delete_race_and_failure_are_not_success(monkeypatch):
    for code, status in [("PreconditionFailed", 409), ("AccessDenied", 502)]:
        client, _, _ = published_week(monkeypatch, draft=storage.Snapshot(b"", "draft"))
        client.delete_object.side_effect = ClientError({"Error": {"Code": code}}, "DeleteObject")
        assert (
            admin.lambda_handler(event("/weeks/2026/1/draft", "DELETE", etag="draft"), None)[
                "statusCode"
            ]
            == status
        )


def test_delete_infrastructure_is_draft_scoped():
    config = Path("aws/terraform/admin.tf").read_text()
    statements = [line for line in config.splitlines() if 'Action = "s3:DeleteObject"' in line]
    assert len(statements) == 1
    assert (
        'Resource = "arn:aws:s3:::${local.data_bucket}/incoming/????/drafts/week??.csv"'
        in statements[0]
    )
    assert '"DELETE /weeks/{season}/{week}/draft"' in config
    assert '"DELETE"' in config


def creation_api(monkeypatch):
    from aws import processing

    from .test_aws_lambda import weekly
    from .test_aws_processing import S3

    monkeypatch.setenv("PBJ_DATA_BUCKET", "pbj-data-jm26")
    monkeypatch.setenv("PBJ_DATA_PREFIX", "data/")
    monkeypatch.setenv("PBJ_ADMIN_CLIENT_ID", "spa")
    monkeypatch.setenv("PBJ_PROCESSOR_FUNCTION", "pbj-processor")
    monkeypatch.setenv("PBJ_SEASON", "2026")
    monkeypatch.setenv("PBJ_WEEK1_CREATION_DATE", "2026-09-08")
    monkeypatch.setattr(processing, "now", lambda: datetime(2026, 9, 14, tzinfo=UTC))
    s3 = S3()
    s3.seed("data/2026/week01.json", weekly())
    s3.seed("data/available-weeks.json", {"2026": [1]})
    monkeypatch.setattr(storage, "client", lambda: s3)
    target = processing.next_creation(storage.client(), storage.StorageConfig.from_environment())
    processor = MagicMock()
    monkeypatch.setattr(boto3, "client", lambda *a, **kw: processor)
    return s3, target, processor


def test_create_next_auth_confirmation_and_server_target(monkeypatch):
    s3, target, processor = creation_api(monkeypatch)
    request = event("/schedules/next", "POST", token=target["token"], confirm=True, week=18)
    unauthorized = dict(request, requestContext={})
    assert admin.lambda_handler(unauthorized, None)["statusCode"] == 403
    assert admin.lambda_handler(event("/schedules/next", "POST"), None)["statusCode"] == 409
    assert (
        admin.lambda_handler(event("/schedules/next", "POST", token=target["token"]), None)[
            "statusCode"
        ]
        == 422
    )
    processor.invoke.assert_not_called()
    processor.invoke.return_value = {
        "Payload": BytesIO(json.dumps(dict(status="ok", season=2026, week=2)).encode())
    }
    result = admin.lambda_handler(request, None)
    assert result["statusCode"] == 200
    invoked = json.loads(processor.invoke.call_args.kwargs["Payload"])
    assert invoked == dict(
        action="create_week",
        season=2026,
        week=2,
        publish_manifest=False,
        creation_token=target["token"],
    )
    assert s3.writes == []


def test_create_next_failures_reconcile_without_retry(monkeypatch):
    for failure in ("provider", "timeout", "malformed", "wrong_target", "race"):
        s3, target, processor = creation_api(monkeypatch)
        if failure == "timeout":
            processor.invoke.side_effect = TimeoutError()
        elif failure == "malformed":
            processor.invoke.return_value = {"Payload": BytesIO(b"invalid")}
        elif failure == "wrong_target":
            processor.invoke.return_value = {
                "Payload": BytesIO(b'{"status":"ok","season":2026,"week":3}')
            }
        else:
            if failure == "race":
                # Creation happens after eligibility is checked, during invocation.

                def race(s3=s3, **kwargs):
                    s3.objects["data/2026/week02.json"] = s3.objects["data/2026/week01.json"]
                    raise TimeoutError()

                processor.invoke.side_effect = race
            else:
                processor.invoke.return_value = {
                    "FunctionError": "Unhandled",
                    "Payload": BytesIO(b"{}"),
                }
        result = admin.lambda_handler(
            event("/schedules/next", "POST", token=target["token"], confirm=True), None
        )
        assert result["statusCode"] == (409 if failure == "race" else 502)
        assert processor.invoke.call_count == 1
        assert s3.writes == []
        if failure == "race":
            processor.invoke.reset_mock()
            result = admin.lambda_handler(
                event("/schedules/next", "POST", token=target["token"], confirm=True), None
            )
            assert result["statusCode"] == 409
            processor.invoke.assert_not_called()


@pytest.mark.parametrize(
    "public,extra",
    [
        (None, None),
        ([], None),
        ({}, None),
        ({"2026": []}, None),
        ({"2026": [True]}, None),
        ({"2026": [1, 3]}, None),
        ({"2026": [1, 2]}, None),
        ({"2027": [1]}, None),
        ({"2026": [1]}, "2026/week03.json"),
        ({"2026": [1]}, "2026/week19.json"),
        ({"2026": [1]}, "2026/week00.json"),
        ({"2026": [1]}, "2026/week1.json"),
        ({"2026": [1]}, "1899/week01.json"),
        ({"2026": [1]}, "10000/week01.json"),
        ({"2026": [1]}, "2026/week02.json.bak"),
        ({"2026": [1]}, "unexpected/week01.json"),
    ],
)
def test_invalid_catalog_fails_closed_without_reading_weeks(monkeypatch, public, extra):
    from aws import processing

    s3, target, processor = creation_api(monkeypatch)
    if public is None:
        del s3.objects["data/available-weeks.json"]
    else:
        s3.seed("data/available-weeks.json", public)
    if extra:
        s3.objects["data/" + extra] = b"must not read"
    s3.get_object = MagicMock(wraps=s3.get_object)
    result = admin.lambda_handler(event("/schedules"), None)
    assert result["statusCode"] == 400
    assert "seasons" not in json.loads(result["body"])
    assert (
        processing.next_creation(storage.client(), storage.StorageConfig.from_environment()) is None
    )
    result = admin.lambda_handler(
        event("/schedules/next", "POST", token=target["token"], confirm=True), None
    )
    assert result["statusCode"] == 409
    processor.invoke.assert_not_called()
    assert all(c.kwargs["Key"] == "data/available-weeks.json" for c in s3.get_object.call_args_list)


def test_malformed_manifest_fails_closed(monkeypatch):
    s3, _, _ = creation_api(monkeypatch)
    s3.objects["data/available-weeks.json"] = b"{invalid"
    result = admin.lambda_handler(event("/schedules"), None)
    assert result["statusCode"] == 400


@pytest.mark.parametrize("saved", [False, True])
def test_open_week_reads_only_requested_schedule_and_private_draft(monkeypatch, saved):
    s3, _, _ = creation_api(monkeypatch)
    s3.objects["data/2026/week02.json"] = s3.objects["data/2026/week01.json"]
    s3.objects["data/2026/week03.json"] = b"broken historical schedule"
    s3.get_object = MagicMock(wraps=s3.get_object)
    s3.get_paginator = MagicMock(wraps=s3.get_paginator)
    for week in (1, 2):
        draft_key = f"incoming/2026/drafts/week{week:02d}.csv"
        if saved:
            s3.objects[draft_key] = b"NAME,NE SEA,TIEBREAKER\nCommissioner,SEA,30\n"
        s3.get_object.reset_mock()
        result = admin.lambda_handler(event(f"/weeks/2026/{week}"), None)
        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        assert body["source"] == ("draft" if saved else "published")
        if saved:
            assert body["etag"] == s3.etag(s3.objects[draft_key])
            assert body["rows"][0][0] == "Commissioner"
        assert [call.kwargs["Key"] for call in s3.get_object.call_args_list] == [
            f"data/2026/week{week:02d}.json",
            f"incoming/2026/drafts/week{week:02d}.csv",
        ]
    s3.get_paginator.assert_not_called()
    s3.get_object.reset_mock()
    result = admin.lambda_handler(event("/weeks/2026/3"), None)
    assert result["statusCode"] == 400
    assert [c.kwargs["Key"] for c in s3.get_object.call_args_list] == ["data/2026/week03.json"]


@pytest.mark.parametrize("published", [False, True])
def test_creation_api_rechecks_state_before_invocation(monkeypatch, published):
    s3, target, processor = creation_api(monkeypatch)
    s3.objects["data/2026/week02.json"] = b"not fetched for eligibility"
    if published:
        s3.seed("data/available-weeks.json", {"2026": [1, 2]})
    s3.get_object = MagicMock(wraps=s3.get_object)
    s3.get_paginator = MagicMock(wraps=s3.get_paginator)
    result = admin.lambda_handler(
        event("/schedules/next", "POST", token=target["token"], confirm=True), None
    )
    assert result["statusCode"] == 409
    processor.invoke.assert_not_called()
    s3.get_object.assert_called_once_with(Bucket="pbj-data-jm26", Key="data/available-weeks.json")
    s3.get_paginator.assert_called_once_with("list_objects_v2")
    assert "data/2026/week03.json" not in s3.objects


def test_multiple_unpublished_weeks_fail_closed(monkeypatch):
    s3, _, processor = creation_api(monkeypatch)
    for week in (2, 3):
        s3.objects[f"data/2026/week{week:02d}.json"] = b"not read"
    assert admin.lambda_handler(event("/schedules"), None)["statusCode"] == 400
    assert (
        admin.lambda_handler(event("/schedules/next", "POST", confirm=True), None)["statusCode"]
        == 409
    )
    processor.invoke.assert_not_called()


@pytest.mark.parametrize(
    ("timestamp", "prepared", "publish"),
    [
        ("2026-09-15T11:59:59+00:00", False, False),
        ("2026-09-15T12:00:00+00:00", False, True),
        ("2026-09-16T12:00:00+00:00", True, True),
    ],
)
def test_portal_api_runs_authorized_creation_or_publication(
    monkeypatch, timestamp, prepared, publish
):
    from aws import lambda_function, processing

    from .test_aws_lambda import weekly

    s3, _, processor = creation_api(monkeypatch)
    monkeypatch.setattr(processing, "now", lambda: datetime.fromisoformat(timestamp))
    if prepared:
        s3.seed("data/2026/week02.json", weekly())
    s3.objects["incoming/2026/drafts/week02.csv"] = b"draft"
    s3.objects["incoming/2026/week02.csv"] = b"submitted"
    before = dict(s3.objects)
    provider = MagicMock()
    provider.get_week.return_value = load_games(Path("data/2026/week01.json"))
    monkeypatch.setattr(processing, "provider", lambda: provider)
    catalog = json.loads(admin.lambda_handler(event("/schedules"), None)["body"])
    target = catalog["next_creation"]
    assert target["action"] == ("publish" if prepared else "create")
    assert target["publish_manifest"] is publish
    assert s3.writes == []

    def invoke(**kwargs):
        request = json.loads(kwargs["Payload"])
        assert request["week"] == 2 and request["publish_manifest"] is publish
        result = lambda_function.lambda_handler(request, None)
        return {"Payload": BytesIO(json.dumps(result).encode())}

    processor.invoke.side_effect = invoke
    result = admin.lambda_handler(
        event(
            "/schedules/next",
            "POST",
            token=target["token"],
            confirm=True,
            week=18,
            publish_manifest=not publish,
            action="publish",
        ),
        None,
    )
    assert result["statusCode"] == 200
    assert ("is published" in json.loads(result["body"])["message"]) is publish
    assert s3.data("data/available-weeks.json") == {"2026": [1, 2] if publish else [1]}
    assert all(s3.objects[k] == v for k, v in before.items() if k != "data/available-weeks.json")
    assert provider.get_week.call_count == (0 if prepared else 1)
    writes = list(s3.writes)
    assert (
        admin.lambda_handler(
            event("/schedules/next", "POST", token=target["token"], confirm=True), None
        )["statusCode"]
        == 409
    )
    assert s3.writes == writes and processor.invoke.call_count == 1


def test_portal_api_rechecks_cutoff_and_rejects_early_publish(monkeypatch):
    from aws import processing

    from .test_aws_lambda import weekly

    s3, early, processor = creation_api(monkeypatch)
    s3.seed("data/2026/week02.json", weekly())
    before = dict(s3.objects)
    assert (
        json.loads(admin.lambda_handler(event("/schedules"), None)["body"])["next_creation"] is None
    )
    assert (
        admin.lambda_handler(
            event(
                "/schedules/next", "POST", token=early["token"], confirm=True, publish_manifest=True
            ),
            None,
        )["statusCode"]
        == 409
    )
    monkeypatch.setattr(processing, "now", lambda: datetime(2026, 9, 15, 12, tzinfo=UTC))
    due = json.loads(admin.lambda_handler(event("/schedules"), None)["body"])["next_creation"]
    assert due["action"] == "publish"
    assert (
        admin.lambda_handler(event("/schedules/next", "POST", token=due["token"]), None)[
            "statusCode"
        ]
        == 422
    )
    assert s3.objects == before and s3.writes == []
    processor.invoke.assert_not_called()


def test_portal_processor_rechecks_cutoff_after_api_confirmation(monkeypatch):
    from aws import lambda_function, processing

    s3, target, processor = creation_api(monkeypatch)
    before = dict(s3.objects)

    def invoke(**kwargs):
        monkeypatch.setattr(processing, "now", lambda: datetime(2026, 9, 15, 12, tzinfo=UTC))
        return lambda_function.lambda_handler(json.loads(kwargs["Payload"]), None)

    processor.invoke.side_effect = invoke
    assert (
        admin.lambda_handler(
            event("/schedules/next", "POST", token=target["token"], confirm=True), None
        )["statusCode"]
        == 502
    )
    assert s3.objects == before and s3.writes == []
    assert processor.invoke.call_count == 1


@pytest.mark.parametrize("completed", [False, True])
def test_portal_api_reconciles_uncertain_publication_without_retry(monkeypatch, completed):
    from aws import lambda_function, processing

    from .test_aws_lambda import weekly

    s3, _, processor = creation_api(monkeypatch)
    s3.seed("data/2026/week02.json", weekly())
    monkeypatch.setattr(processing, "now", lambda: datetime(2026, 9, 15, 12, tzinfo=UTC))
    target = processing.next_creation(s3, storage.StorageConfig.from_environment())
    assert target is not None
    before = dict(s3.objects)

    def timeout(**kwargs):
        if completed:
            lambda_function.lambda_handler(json.loads(kwargs["Payload"]), None)
        raise TimeoutError()

    processor.invoke.side_effect = timeout
    result = admin.lambda_handler(
        event("/schedules/next", "POST", token=target["token"], confirm=True), None
    )
    assert result["statusCode"] == (200 if completed else 409)
    assert ("is published" in json.loads(result["body"])["message"]) is completed
    assert processor.invoke.call_count == 1
    assert s3.writes == (["data/available-weeks.json"] if completed else [])
    assert all(s3.objects[k] == v for k, v in before.items() if k != "data/available-weeks.json")


def test_admin_release_configuration_matches_processor():
    config = " ".join(Path("aws/terraform/admin.tf").read_text().split())
    assert "PBJ_SEASON = tostring(local.season)" in config
    assert "PBJ_WEEK1_CREATION_DATE = local.week1_creation_date" in config


def announcement_document():
    return {"top": {"text": "Week 9", "link": None}, "bottom": {"text": "", "link": None}}


def test_announcement_reads_missing_and_existing(monkeypatch):
    client = setup_api(monkeypatch)
    for snapshot in [None, storage.Snapshot(json.dumps(announcement_document()).encode(), '"v1"')]:

        def read(s, c, key, snapshot=snapshot):
            assert key == "data/announcements.json"
            return snapshot

        monkeypatch.setattr(storage, "read", read)
        result = admin.lambda_handler(event("/announcements"), None)
        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        assert body["etag"] == (snapshot.etag if snapshot else None)
        assert body["document"]["top"]["text"] == ("Week 9" if snapshot else "")
    client.list_objects_v2.assert_not_called()


@pytest.mark.parametrize("etag", [None, '"v1"'])
def test_announcement_publication(monkeypatch, etag):
    client = setup_api(monkeypatch)
    result = admin.lambda_handler(
        event("/announcements", "PUT", document=announcement_document(), etag=etag), None
    )
    assert result["statusCode"] == 200
    call = client.put_object.call_args.kwargs
    assert call["Bucket"] == "private"
    assert call["Key"] == "data/announcements.json"
    assert json.loads(call["Body"]) == announcement_document()
    assert call["IfMatch" if etag else "IfNoneMatch"] == (etag or "*")
    assert json.loads(result["body"])["etag"] == "new-version"


def test_announcement_conflict_and_required_version(monkeypatch):
    client = setup_api(monkeypatch)
    assert (
        admin.lambda_handler(
            event("/announcements", "PUT", document=announcement_document()), None
        )["statusCode"]
        == 400
    )
    for code in ["PreconditionFailed", "ConditionalRequestConflict", "AccessDenied"]:
        client.put_object.side_effect = ClientError({"Error": {"Code": code}}, "PutObject")
        result = admin.lambda_handler(
            event("/announcements", "PUT", document=announcement_document(), etag=None), None
        )
        assert result["statusCode"] == (502 if code == "AccessDenied" else 409)
        assert code not in result["body"]


@pytest.mark.parametrize(
    "link",
    [
        {"label": "Schedule", "url": "https://example.com/week?x=1"},
        {"label": "Schedule", "url": "http://example.com"},
    ],
)
def test_announcement_valid_links(link):
    value = announcement_document()
    value["top"]["link"] = link
    assert admin.validate_announcements(value) == value


@pytest.mark.parametrize(
    "link",
    [
        False,
        {},
        {"label": " ", "url": "https://example.com"},
        {"label": "Go", "url": "javascript:alert(1)"},
        {"label": "Go", "url": "/relative"},
        {"label": "Go", "url": "https://"},
        {"label": "Go", "url": "https://example.com:bad"},
        {"label": "Go", "url": "https://example.com/ bad"},
    ],
)
def test_announcement_invalid_links(link):
    value = announcement_document()
    value["top"]["link"] = link
    with pytest.raises(ValueError):
        admin.validate_announcements(value)


@pytest.mark.parametrize(
    "value",
    [
        None,
        {},
        {"top": {}, "bottom": {}},
        {"top": {"text": "x" * 2001, "link": None}, "bottom": {"text": "", "link": None}},
    ],
)
def test_announcement_invalid_documents(value):
    with pytest.raises(ValueError):
        admin.validate_announcements(value)


def test_announcement_request_size_and_routes(monkeypatch):
    client = setup_api(monkeypatch)
    assert (
        admin.lambda_handler(event("/announcements", "PUT", document="x" * 25000, etag=None), None)[
            "statusCode"
        ]
        == 413
    )
    assert admin.lambda_handler(event("/announcements", "DELETE"), None)["statusCode"] == 405
    denied = event("/announcements", "PUT", document=announcement_document(), etag=None)
    denied["requestContext"]["authorizer"]["jwt"]["claims"]["scope"] = "openid"
    assert admin.lambda_handler(denied, None)["statusCode"] == 403
    client.put_object.assert_not_called()


def test_announcement_missing_object_uses_direct_read(monkeypatch):
    from botocore.stub import Stubber

    monkeypatch.setenv("PBJ_DATA_BUCKET", "private")
    monkeypatch.setenv("PBJ_DATA_PREFIX", "data/")
    monkeypatch.setenv("PBJ_ADMIN_CLIENT_ID", "spa")
    client = boto3.client(
        "s3",
        region_name="us-east-2",
        aws_access_key_id="test",
        aws_secret_access_key="test",  # noqa: S106
    )
    monkeypatch.setattr(storage, "client", lambda: client)
    with Stubber(client) as stub:
        stub.add_client_error(
            "get_object",
            service_error_code="NoSuchKey",
            http_status_code=404,
            expected_params={"Bucket": "private", "Key": "data/announcements.json"},
        )
        result = admin.lambda_handler(event("/announcements"), None)
        assert result["statusCode"] == 200
        assert json.loads(result["body"]) == {
            "document": {position: {"text": "", "link": None} for position in ("top", "bottom")},
            "etag": None,
        }
        stub.assert_no_pending_responses()


@pytest.mark.parametrize(
    ("listed", "list_error", "expected_status"),
    [
        ([], None, 200),
        (["data/announcements.json.backup"], None, 200),
        (["data/announcements.json"], None, 502),
        ([], "AccessDenied", 502),
    ],
)
def test_announcement_denied_read_checks_exact_key(
    monkeypatch, listed, list_error, expected_status
):
    real_read = storage.read
    client = setup_api(monkeypatch)
    monkeypatch.setattr(storage, "read", real_read)
    client.get_object.side_effect = ClientError({"Error": {"Code": "AccessDenied"}}, "GetObject")
    client.list_objects_v2.return_value = {"Contents": [{"Key": key} for key in listed]}
    if list_error:
        client.list_objects_v2.side_effect = ClientError(
            {"Error": {"Code": list_error}}, "ListObjectsV2"
        )
    result = admin.lambda_handler(event("/announcements"), None)
    assert result["statusCode"] == expected_status
    client.get_object.assert_called_once_with(Bucket="private", Key="data/announcements.json")
    client.list_objects_v2.assert_called_once_with(
        Bucket="private", Prefix="data/announcements.json", MaxKeys=1
    )
    body = json.loads(result["body"])
    if expected_status == 200:
        assert body == {
            "document": {position: {"text": "", "link": None} for position in ("top", "bottom")},
            "etag": None,
        }
    else:
        assert "document" not in body
        assert "AccessDenied" not in body["message"]


def test_announcement_existing_direct_read_does_not_list(monkeypatch):
    real_read = storage.read
    client = setup_api(monkeypatch)
    monkeypatch.setattr(storage, "read", real_read)
    client.get_object.return_value = {
        "Body": BytesIO(json.dumps(announcement_document()).encode()),
        "ETag": "version",
    }
    result = admin.lambda_handler(event("/announcements"), None)
    assert result["statusCode"] == 200
    assert json.loads(result["body"]) == {"document": announcement_document(), "etag": "version"}
    client.list_objects_v2.assert_not_called()
