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
python -m pytest tests/python/test_aws_lambda.py
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

## Public AWS preview

The assigned HTTPS CloudFront hostname is publicly accessible, without viewer
login. Both S3 origins remain private: `pbj-preview-jm26` holds static files;
`/data/*` routes to Lambda-maintained `pbj-data-jm26/data/*`. OAC signs both
origins. Bucket grants allow only `GetObject` from this distribution, and the
operational grant covers only `data/*`, never `incoming/*` or `terraform/*`.
The new bucket blocks all public access and has no website endpoint.

After reviewed infrastructure deployment, retrieve the URL:

```bash
terraform -chdir=aws/terraform output -raw preview_hostname
```

The existing branch workflow retains quality gates and Lambda deployment, then
runs the shared `python -m scripts.build_site` and `python -m aws.deploy_site`.
The uploader selects static files from `build/site`, including generated document
cards and canonical legal files, omitting `CNAME`, `data/`, CSVs and credentials.
It only puts objects in the static bucket; it never syncs or deletes. Removed
static files are retained until explicitly cleaned up. Pages keeps its current
build and data publishing behavior.

Both CloudFront behaviors use managed CachingDisabled. Static uploads send
`Cache-Control: no-cache`; unversioned files revalidate in browsers. JSON responses
override browser cache headers with `no-store`, and all data fetches (including
available-weeks) use `no-store`. Missing-object error caching is zero (S3 imposes
a one-second minimum). No invalidation is required for Lambda or static updates.
Home Screen resume behavior still requires device validation under #20.

### Before the first deployment

Review the IAM templates in `aws/iam/` and update the existing users, retaining
current permissions and secrets. The deploy user gains only `s3:PutObject` on
the new static bucket, with no operational data writes or CloudFront permissions.
The infrastructure user needs the listed bucket inspection/configuration and
CloudFront create/read/update actions. Replace `ACCOUNT_ID`; CloudFront resource
IDs are unavailable until creation. For bootstrap only, use account-scoped
`distribution/*`, `origin-access-control/*`, and `response-headers-policy/*` in
those three read/update statements, then narrow to the output distribution ID
and the OAC/header-policy IDs in state. Create operations require `Resource: *`.
No additional identity, secret, domain or certificate is needed.

AWS CLI confirmed that `pbj-data-jm26` has no existing bucket policy
(`NoSuchBucketPolicy`). Terraform directly owns the new operational bucket policy:
one `PBJPreviewDataRead` statement allows this distribution to read only `data/*`.
The bucket itself, operational JSON, public-access block and encryption settings
are unchanged. The expected initial plan adds seven managed preview resources.
Existing processor, scheduler and state resources should be unchanged.
The guard continues to reject deletion/replacement and non-allowlisted resources.
Do not push this branch until review: pushes trigger the existing apply workflow.

After deployment, check `/`, `/assets/app.js`, `/assets/documents/rules.html`,
`/LEGAL.md`, `/data/available-weeks.json` and an AWS week/season JSON over HTTPS.
Confirm `/incoming/<season>/weekNN.csv` and `/terraform/pbj.tfstate` are denied,
as are direct anonymous S3 reads. Check JSON `Cache-Control: no-store`, HTTPS
redirects, and a Lambda JSON update/weekly rollover without a frontend release.
Compare AWS and Pages separately and verify on desktop and iOS. Local tests
validate selection and configuration; only deployed checks prove actual access,
routing, freshness and effective IAM permissions.

For a small preview, estimate under $1/month incremental hosting while within
CloudFront's account-wide pay-as-you-go free allowance (1 TB transfer and
10 million requests/month). S3 still charges for uncached reads, storage and
uploads: 100,000 GETs are about $0.04, plus a small static artifact and uploads.
This is a traffic assumption, not a spending cap; existing Lambda costs are
separate. New-account S3 credits/Free Tier eligibility depend on account age and
plan; do not assume the older 12-month allowance applies. See current
[CloudFront allowances](https://aws.amazon.com/cloudfront/faqs/) and
[S3 pricing and credits](https://aws.amazon.com/s3/pricing/).
