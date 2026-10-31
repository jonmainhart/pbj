"""Import the Lambda layout outside the checkout without AWS configuration."""

import shutil
import subprocess
import sys
from pathlib import Path
from textwrap import dedent


def test_staged_artifact_imports_its_own_modules(tmp_path, monkeypatch):
    root = Path(__file__).resolve().parents[2]
    shutil.copy(root / "aws/lambda_function.py", tmp_path)
    (tmp_path / "aws").mkdir()
    for name in ("__init__", "processing", "storage"):
        shutil.copy(root / f"aws/{name}.py", tmp_path / "aws")
    shutil.copytree(
        root / "scripts", tmp_path / "scripts", ignore=shutil.ignore_patterns("__pycache__")
    )
    shutil.copytree(
        root / "src/pbj", tmp_path / "pbj", ignore=shutil.ignore_patterns("__pycache__")
    )
    monkeypatch.delenv("PYTHONPATH", raising=False)
    for name in ("PBJ_DATA_BUCKET", "PBJ_DATA_PREFIX", "PBJ_SEASON", "PBJ_API_KEY_PARAMETER"):
        monkeypatch.delenv(name, raising=False)
    workflow = (root / ".github/workflows/deploy-aws.yml").read_text()
    code = dedent(workflow.split("python - <<'PY'\n", 1)[1].split("          PY\n", 1)[0])
    result = subprocess.run(  # noqa: S603 - fixed interpreter, local artifact, no AWS calls
        [sys.executable, "-c", code], cwd=tmp_path, capture_output=True, text=True
    )
    assert result.returncode == 0, result.stderr
