"""Build a deterministic placeholder used only for initial function creation."""

from pathlib import Path
from zipfile import ZipFile, ZipInfo

with ZipFile(Path(__file__).parent / "terraform/bootstrap.zip", "w") as archive:
    archive.writestr(
        ZipInfo("lambda_function.py", (2026, 1, 1, 0, 0, 0)),
        "def lambda_handler(event, context):\n"
        '    raise RuntimeError("Application deployment has not completed")\n',
    )
