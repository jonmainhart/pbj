"""Commissioner CSV validation contracts."""

import json
from io import BytesIO, StringIO
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import boto3
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


def test_authorization_fails_closed(monkeypatch):
    setup_api(monkeypatch)
    assert admin.lambda_handler({}, None)["statusCode"] == 403
    for claim, value in [("token_use", "id"), ("scope", "openid"), ("client_id", "other")]:
        request = event()
        request["requestContext"]["authorizer"]["jwt"]["claims"][claim] = value
        assert admin.lambda_handler(request, None)["statusCode"] == 403


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


def test_submission_blocks_invalid_and_empty(monkeypatch):
    client = setup_api(monkeypatch)
    for text in ["", "NAME,TIEBREAKER\nAlice,nan\n"]:
        result = admin.lambda_handler(
            event("/weeks/2026/1/submit", "POST", csv=text, confirm=True), None
        )
        assert result["statusCode"] == 422
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


def test_schedule_selection_reuses_active_week_and_latest_fallback(monkeypatch):
    setup_api(monkeypatch)
    monkeypatch.setattr(
        storage, "list_keys", lambda *a: ["data/2026/week01.json", "data/2026/week02.json"]
    )
    # Fixture week is final: fallback selects latest, then unfinished week uses existing selector.
    result = json.loads(admin.lambda_handler(event("/schedules"), None)["body"])
    assert result["week"] == 2
    monkeypatch.setattr(admin, "select_active_week", lambda weeks: 1)
    result = json.loads(admin.lambda_handler(event("/schedules"), None)["body"])
    assert result["week"] == 1


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
    setup_api(monkeypatch)
    monkeypatch.setattr(storage, "list_keys", lambda *a: ["data/2026/week01.json"])
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
