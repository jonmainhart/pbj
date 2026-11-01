"""Correctable CSV diagnostics backed by the existing Numbers importer."""

import csv
import math
from io import StringIO
from typing import Any

from pbj.domain.game import Game
from pbj.importers import numbers


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
