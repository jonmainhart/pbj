"""Protect production deployments from being displaced by no-op triggers."""

import re
from pathlib import Path


def test_pages_concurrency_queues_runs_without_canceling_pending_deployments() -> None:
    workflow = (
        Path(__file__).resolve().parents[1] / ".github/workflows/deploy-pages.yml"
    ).read_text(encoding="utf-8")
    concurrency = re.search(r"^concurrency:\n((?:[ \t]+[^\n]*\n)+)", workflow, re.MULTILINE)
    assert concurrency is not None
    settings = dict(
        line.strip().split(": ", maxsplit=1)
        for line in concurrency.group(1).splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    )

    # A no-change or failed processing run must not displace a pending push deploy.
    assert settings["queue"] == "max"
    assert settings["cancel-in-progress"] == "false"
