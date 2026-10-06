import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

export default function prepareDocuments() {
    const python = process.env.PBJ_PYTHON
        || (existsSync(".venv/bin/python") ? ".venv/bin/python" : "python3");
    const result = spawnSync(python, ["-m", "scripts.generate_documents"], {
        stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error("Document generation failed. Install Python dependencies with .[dev,docs].");
    }
}
