"""Correctable CSV diagnostics backed by the existing Numbers importer."""

import csv
import math
from io import StringIO
from typing import Any

from pbj.domain.game import Game
from pbj.importers import numbers


def published_csv(players: Any, games: list[Game]) -> str:
    """Reconstruct published picks without dropping unrepresentable player data."""
    if not isinstance(players, list):
        raise ValueError("Published players must be a list")
    if not players:
        return ""
    game_ids = {g.id for g in games}
    if len(game_ids) != len(games):
        raise ValueError("Published schedule contains duplicate game IDs")
    output = StringIO()
    writer = csv.writer(output)
    writer.writerow(
        ["NAME", *[f"{g.away.abbreviation} {g.home.abbreviation}" for g in games], "TIEBREAKER"]
    )
    for index, player in enumerate(players, start=1):
        message = f"Published player {index}"
        if not isinstance(player, dict):
            raise ValueError(f"{message} must be an object")
        name, picks, tiebreaker = (player.get(k) for k in ("name", "picks", "tiebreaker"))
        if not isinstance(name, str) or not name.strip():
            raise ValueError(f"{message} requires a displayed name")
        if not isinstance(picks, dict) or picks.keys() - game_ids:
            raise ValueError(f"{message} picks must reference only scheduled game IDs")
        for game in games:
            if game.id in picks and picks[game.id] not in (
                game.away.abbreviation,
                game.home.abbreviation,
            ):
                raise ValueError(f"{message} has an invalid pick for game {game.id}")
        if (
            isinstance(tiebreaker, bool)
            or not isinstance(tiebreaker, (int, float))
            or not math.isfinite(tiebreaker)
            or tiebreaker < 0
        ):
            raise ValueError(f"{message} requires a finite nonnegative numeric tiebreaker")
        writer.writerow([name, *[picks.get(g.id, numbers.NON_PICK) for g in games], tiebreaker])
    text = output.getvalue()
    result = inspect_csv(text, games)
    errors = [i["message"] for i in result["issues"] if i["severity"] == "error"]
    if errors:
        raise ValueError(f"Published picks cannot be reconstructed: {'; '.join(errors)}")
    return text


def inspect_csv(text: str, games: list[Game]) -> dict[str, Any]:
    """Preserve editable input and report all errors with zero-based cell coordinates."""
    expected = [
        "NAME",
        *[f"{g.away.abbreviation} {g.home.abbreviation}" for g in games],
        "TIEBREAKER",
    ]
    issues: list[dict[str, Any]] = []

    def issue(row: int, column: int, message: str, severity: str = "error") -> None:
        issues.append(dict(row=row, column=column, message=message, severity=severity))

    try:
        raw = list(csv.reader(StringIO(text.lstrip("\ufeff")), strict=True))
    except csv.Error as exc:
        return dict(
            headers=expected,
            rows=[],
            csv=text,
            issues=[dict(row=-1, column=0, message=str(exc), severity="error")],
        )
    if not text:
        raw = [expected]
    try:
        start = numbers._find_header_row(raw)
    except ValueError as exc:
        start = 0
        issue(-1, 0, str(exc))
    headers = numbers._headers_through_correct([c.strip() for c in (raw[start] if raw else [])])
    rows = [row for row in raw[start + 1 :] if not numbers._row_is_empty(row)]
    if len(set(headers)) != len(headers):
        issue(-1, 0, "Duplicate column headers")
    for name in ("NAME", "TIEBREAKER"):
        if name not in headers:
            issue(-1, 0, f"Missing {name} column (headers are case sensitive)")
    try:
        columns = numbers._resolve_game_columns(headers, games)
        if len({g.id for g in columns.values()}) != len(games):
            raise ValueError("Duplicate or missing matchup columns")
    except ValueError as exc:
        columns = {}
        issue(-1, 0, str(exc))
    seen: dict[str, int] = {}
    for r, values in enumerate(rows):
        if len(values) < len(headers) or (len(values) > len(headers) and "CORRECT" not in headers):
            issue(r, 0, "Malformed row: column count differs from header")
        row = numbers._row_to_dict(headers, values)
        name = row.get("NAME", "")
        try:
            player_id = numbers._player_id(numbers._required_value(name, "Missing player name"))
            if player_id in seen:
                issue(r, headers.index("NAME"), "Duplicate player name or ID")
                issue(seen[player_id], headers.index("NAME"), "Duplicate player name or ID")
            seen[player_id] = r
        except ValueError as exc:
            issue(r, headers.index("NAME") if "NAME" in headers else 0, str(exc))
        try:
            value = numbers._parse_tiebreaker(row.get("TIEBREAKER"), name)
            if not math.isfinite(value) or value < 0:
                raise ValueError("Tiebreaker must be a finite nonnegative number")
        except ValueError as exc:
            issue(r, headers.index("TIEBREAKER") if "TIEBREAKER" in headers else 0, str(exc))
        for column, game in columns.items():
            pick = numbers._normalize_team_abbreviation(row.get(column, ""))
            if pick == numbers.NON_PICK:
                issue(r, headers.index(column), "N/P: no pick will be recorded", "warning")
            elif pick not in {game.away.abbreviation, game.home.abbreviation}:
                issue(r, headers.index(column), "Missing or invalid pick")
    output = StringIO()
    writer = csv.writer(output)
    writer.writerow(headers)
    writer.writerows(rows)
    canonical = output.getvalue()
    if not any(i["severity"] == "error" for i in issues):
        try:
            numbers.import_players(StringIO(canonical), games)
        except ValueError as exc:
            issue(-1, 0, str(exc))
    return dict(headers=headers, rows=rows, csv=canonical, issues=issues)
