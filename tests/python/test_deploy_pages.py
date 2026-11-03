"""Protect production deployments from being displaced by no-op triggers."""

import re
import subprocess
from pathlib import Path
from textwrap import dedent

import pytest


def test_pages_concurrency_queues_runs_without_canceling_pending_deployments() -> None:
    workflow = (
        Path(__file__).resolve().parents[2] / ".github/workflows/deploy-pages.yml"
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


@pytest.mark.parametrize(
    ("path", "expected"),
    [
        ("RULES.md", (False, True, True)),
        ("LEGAL.md", (False, True, True)),
        ("LICENSE", (False, True, True)),
        ("LICENSE-SCOPE.md", (False, True, True)),
        ("README.md", (False, False, True)),
        ("site/index.html", (False, True, True)),
        ("site/assets/style.css", (False, True, True)),
        ("site/assets/app.js", (False, True, True)),
        ("tests/frontend/browser/admin.spec.js", (False, True, True)),
        ("src/pbj/scoring.py", (True, False, True)),
        ("tests/python/test_admin.py", (True, False, True)),
        ("aws/processing.py", (True, False, True)),
        ("scripts/build_site.py", (True, True, True)),
        ("aws/terraform/main.tf", (True, True, True)),
        ("aws/check-terraform.sh", (True, True, True)),
        (".github/workflows/deploy-aws.yml", (True, True, True)),
        ("pyproject.toml", (True, True, True)),
        ("package.json", (True, True, True)),
        ("data/2026/week01.json", (False, False, False)),
        ("data/2026/week01.csv", (False, False, False)),
    ],
)
def test_quality_selection(path, expected, tmp_path, monkeypatch):
    workflow = Path(".github/workflows/quality.yml").read_text()
    code = dedent(workflow.split("python - <<'PY'\n", 1)[1].split("          PY\n", 1)[0])
    output = tmp_path / "outputs"
    monkeypatch.setenv("EVENT", "push")
    monkeypatch.setenv("BASE", "before")
    monkeypatch.setenv("HEAD", "after")
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    monkeypatch.setattr(subprocess, "run", lambda *args, **kwargs: None)
    monkeypatch.setattr(subprocess, "check_output", lambda *args, **kwargs: path.encode() + b"\0")
    exec(compile(code, "quality.yml", "exec"), {})  # noqa: S102 - execute the checked-in selector
    assert output.read_text().splitlines() == [
        f"{key}={str(value).lower()}"
        for key, value in zip(("python", "frontend", "build"), expected, strict=True)
    ]
