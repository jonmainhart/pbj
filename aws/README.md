# PBJ AWS

AWS infrastructure and application deployment are managed through GitHub Actions on `test/aws-upgrade`. GitHub Pages remains production until cutover.

## Terraform

Infrastructure is managed through `aws/terraform/` using Terraform 1.17.0.

- **Deployment:** `.github/workflows/terraform.yml` validates, plans, and applies changes automatically.
- **State:** `s3://pbj-data-jm26/terraform/pbj.tfstate`, with S3 native locking.
- **Credentials:** `pbj-aws-infra` uses `pbj-github-terraform`; `pbj-aws-deploy` uses `pbj-github-deploy`.
- **IAM policy templates:** `aws/iam/`.

Local validation:

```bash
bash aws/check-terraform.sh
```

GitHub Actions handles `terraform apply`. Terraform-managed resources should not be modified manually in AWS.

## Resources

- **Region:** `us-east-2`
- **Lambda:** `pbj-processor`
- **Data:** `s3://pbj-data-jm26/data/`
- **AWS dependencies:** `pyproject.toml` (`.[aws]`)

## Local checks

```bash
python -m pytest tests/test_aws_lambda.py
```

## Lambda testing

Invoke weekly scoring without modifying S3:

```bash
aws lambda invoke \
  --profile pbj \
  --region us-east-2 \
  --function-name pbj-processor \
  --cli-binary-format raw-in-base64-out \
  --payload '{"action":"score_week","season":2026,"week":7}' \
  /tmp/pbj-result.json

cat /tmp/pbj-result.json
```

`write` defaults to `false`. Set `"write": true` to persist changed results using conditional S3 writes. An empty event (`{}`) runs the import smoke test.

Check the invocation response for `FunctionError`; a successful CLI exit does not guarantee successful Lambda execution.

## Manual commissioner CSV import

Original commissioner CSVs are uploaded to `incoming/<season>/weekNN.csv`.
The Lambda `import_picks` action processes the specified season and week.
The original CSV remains in S3 for retries and corrections. Automatic CSV
processing is not yet enabled.
