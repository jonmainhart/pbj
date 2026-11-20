"""Verify quality workflow change selection."""

import subprocess
from pathlib import Path
from textwrap import dedent

import pytest


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
        ("data/2026/week01.json", (True, True, True)),
        ("data/2026/week01.csv", (True, True, True)),
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
