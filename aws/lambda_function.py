"""Lambda event validation, dispatch, and deployment import smoke check."""

import os
from datetime import datetime
from typing import Any

from aws import processing
from scripts import (
    aggregate_season,
    generate_manifest,
    import_picks,
    score_week,
    select_active_week,
    should_poll,
    update_games,
)


def lambda_handler(event: Any, context: Any) -> dict[str, Any]:
    """Validate processing requests without initializing AWS for the smoke check."""
    if not isinstance(event, dict):
        raise ValueError("event must be an object")
    if not event:
        return {
            "status": "ok",
            "modules": [
                module.__name__
                for module in (
                    aggregate_season,
                    generate_manifest,
                    import_picks,
                    score_week,
                    select_active_week,
                    should_poll,
                    update_games,
                )
            ],
        }

    action = event.get("action")
    if action not in ("create_week", "poll_games", "score_week", "update_week"):
        raise ValueError("action must be create_week, poll_games, score_week, or update_week")
    season = event.get("season")
    if season is None and action not in ("score_week", "update_week"):
        configured = os.environ.get("PBJ_SEASON")
        season = int(configured) if configured else None
    if type(season) is not int or not 1900 <= season <= 9999:
        raise ValueError("season must be an integer from 1900 to 9999")
    if action == "score_week":
        week = event.get("week")
        write = event.get("write", False)
        if type(week) is not int or not 1 <= week <= 18:
            raise ValueError("week must be an integer from 1 to 18")
        if type(write) is not bool:
            raise ValueError("write must be a boolean")
        return processing.score_existing_week(season, week, write)
    scheduled = None
    if "scheduled_time" in event:
        value = event["scheduled_time"]
        if not isinstance(value, str):
            raise ValueError("scheduled_time must be an ISO timestamp")
        scheduled = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if scheduled.tzinfo is None:
            raise ValueError("scheduled_time must be timezone-aware")
    week = None
    if action == "update_week":
        week = event.get("week")
        if type(week) is not int or not 1 <= week <= 18:
            raise ValueError("week must be an integer from 1 to 18")
    if action == "create_week":
        if scheduled is not None:
            if "week" in event:
                raise ValueError("Specify either week or scheduled_time, not both")
            if season != int(os.environ["PBJ_SEASON"]):
                raise ValueError("Scheduled creation must use the configured season")
        else:
            week = event.get("week")
            if type(week) is not int or not 1 <= week <= 18:
                raise ValueError("Manual creation requires a week from 1 to 18")
    return processing.process(action, season, week, scheduled)
