"""Import smoke check for the initial PBJ Lambda deployment."""

from typing import Any

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
    """Confirm the operational modules load without processing or persisting data."""
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
