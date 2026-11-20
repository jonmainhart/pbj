# PBJ Dashboard

PBJ is a mobile-friendly dashboard for a weekly football pool. It imports the
commissioner's picks, retrieves NFL schedules and scores, and displays weekly
and season results. Players can view the dashboard without an account; the
commissioner portal requires an authorized account. See [pool rules](RULES.md).

## Repository and production

- `site/` contains the static dashboard and commissioner portal.
- `src/pbj/` contains Python domain logic; `scripts/` provides reusable processing and build commands.
- `aws/` contains the Lambda integration, deployment tooling, and Terraform configuration.
- `tests/` contains Python and frontend tests.

CloudFront serves the static frontend and operational data stored in S3. AWS
Lambda handles backend processing and the commissioner API. Application source
is maintained in Git; operational data is authoritative in S3 and is not part
of the repository or static build. The static build generates public documents
from their source files and does not upload or replace operational data.

## Local development

Use Python 3.11 or later and a Node version supported by `package.json`:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install '.[dev,aws]'
npm ci
npx playwright install chromium
npm run build:admin
python -m scripts.build_site
python -m http.server 8000 --bind 127.0.0.1 --directory build/site
```

Open `http://127.0.0.1:8000/` to preview static assets and generated documents.
A functioning dashboard needs separately supplied operational data or mocked
responses, as in the frontend tests; production retrieves data through CloudFront
and S3. The local static shell has no live commissioner configuration; browser
tests mock the API. Reinstall the Python
package after changing its source or dependencies because the install is not
editable. Tests use fixtures and mocked services without AWS credentials.

```bash
ruff check .
ruff format --check .
mypy src scripts aws tests/python
pytest
npm run lint
npm run test:unit
npm run test:browser
bash aws/check-terraform.sh
```

## Deployment and recovery

`main` is the authoritative deployment branch. A push to `main` or a manual
run of [AWS infrastructure and deployment](.github/workflows/terraform.yml)
on `main` runs quality checks, validates and applies an approved Terraform
plan, then calls [Deploy AWS application](.github/workflows/deploy-aws.yml) to
publish Lambda code and static assets. Review workflow results after deployment.
The local Terraform check does not use remote state.

For deployment failures, inspect the Actions run and Lambda logs. After an
uncertain commissioner submission, allow processing to finish and inspect the
published results before retrying the same input. For a bad release, deploy a
reviewed correction or rollback through the normal workflow; inspect operational
data and backups before attempting data recovery. Static uploads do not delete
stale objects.

## License

Source and project documentation use the [Apache License 2.0](LICENSE).
Participant data, PBJ artwork and branding, and third-party material have
separate terms; see [license scope](LICENSE-SCOPE.md) and [legal notices](LEGAL.md).
