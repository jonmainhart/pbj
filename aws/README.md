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

## Commissioner portal (local implementation; review before deployment)

`/admin/` is a vanilla JavaScript editor with locally compiled Tailwind v4 CSS:
`npm ci && npm run build:admin`, then `python -m scripts.build_site`. The public
dashboard retains its existing CSS and processing. The static shell contains no
commissioner CSVs or credentials. Terraform writes public OAuth/API settings to
`assets/admin-config.json` in the preview bucket; the static uploader does not
manage that file. GitHub Pages remains production and has no admin configuration.

The preview adds one Cognito Essentials pool (managed login v2), one public SPA
client, one JWT-protected HTTP API, and `pbj-admin`. Accounts are provisioned
individually; self-registration is disabled. Authorization-code + S256 PKCE uses
a random, checked state and a ten-minute verifier window. Access tokens remain in
memory, expire after 30 minutes, and are never saved to localStorage. Reloading
requires sign-in again. Every API route requires `pbj/admin`; Lambda additionally
checks the gateway-verified access-token type, subject, scope and client ID.
The pool is dedicated to commissioners: every provisioned account has admin
access. Disabling a user does not invalidate an already issued JWT immediately;
allow its remaining 30-minute lifetime when revoking access.

After reviewing and deploying Terraform, obtain `admin_user_pool_id` and
`preview_hostname` outputs. A separately authorized operator with
`cognito-idp:AdminCreateUser` for that pool provisions each commissioner:

```bash
aws cognito-idp admin-create-user --region us-east-2 \
  --user-pool-id POOL_ID --username commissioner@example.com \
  --user-attributes Name=email,Value=commissioner@example.com \
  --desired-delivery-mediums EMAIL
```

Cognito sends the temporary password; the user changes it at managed login.
Only the preview `/admin/` HTTPS URL is an allowed callback/logout URL. No client
secret, new IAM user, server, or database is required. Deploy both Lambdas using
the reviewed branch workflow before opening the portal; their initial Terraform
bootstrap intentionally cannot process requests.

Before deployment, update the existing IAM users from `aws/iam/` (replace
`ACCOUNT_ID`, `ADMIN_POOL_ID`, `ADMIN_API_ID` and existing preview IDs). Infra
permissions add the admin role/PassRole, Lambda and log group, scoped API Gateway
management, Cognito configuration/branding, the CloudFront rewrite function, and
one static config object. For initial creation only, pool/API IDs are unknown:
use account/region-scoped `userpool/*` and `/apis/*`, then narrow them to outputs.
The deploy user adds code-update/read permissions for **only** `pbj-admin`.
Neither deployment user gains commissioner CSV access. Account provisioning is
an operator permission and is intentionally absent from these workflow policies.
The admin execution role reads schedules, conditionally writes private CSVs,
and invokes only `pbj-processor`; it cannot publish JSON. Existing scheduler and
processor settings are retained. The plan guard permits only named additions
and still rejects deletion/replacement.

Private CSV paths in `pbj-data-jm26`:

- Draft: `incoming/<season>/drafts/weekNN.csv` (can contain validation errors).
- Submitted importer input: `incoming/<season>/weekNN.csv`.
- Published processor output: `data/<season>/weekNN.json`.

Opening a week prefers the private draft, then published picks, then an empty
schedule-derived table. Published weeks open read-only even when a draft exists.
Editing requires acknowledgement; the warning remains visible, and resubmission
requires a separate confirmation enforced by both the portal and API.

Private saves never publish picks. ETags prevent overwriting another session's
changes. Delete Draft removes only the private draft and reloads published picks
or the empty schedule; missing drafts and stale versions are errors. Submitted
inputs and published JSON remain untouched.

Revert Changes restores the table originally loaded for this session, including
reconciling autosaved edits. Failed or uncertain writes preserve recoverable work.
An unconfirmed initial save is checked against the server before reverting; a
draft found there must be explicitly reopened rather than assumed safe to delete.
Reopen Saved Draft loads the current shared draft. Confirming discard clears the
obsolete device copy only after the fetch succeeds, without a second recovery
decision. Drafts retain aliases and N/P values.

Defaults reuse the earliest unfinished week selection,
falling back to the latest available schedule. Explicit unavailable weeks return
404 without substitution. The newest available season is the initial season.
CSV requests are limited to 250 KB in the browser and 500 KB at the API envelope.

Submission confirms intent, validates using Numbers importer rules plus duplicate
IDs, malformed rows and finite/nonnegative tiebreakers, saves the draft, writes
the validated CSV to the private importer path, then synchronously invokes
`import_picks`. Only an actual processor success is shown as successful. Drafts
are retained on failure. Submitted-object metadata records `pending`/`complete`;
a different CSV cannot replace an unresolved input. Retrying the same CSV runs
the existing idempotent importer and repairs partial week/season publication.
Admin concurrency is one; stale drafts and conditional S3 writes prevent
accidental overwrites. Do not run manual imports concurrently with portal edits.

HTTP API integrations time out at 30 seconds while the admin Lambda may continue
for up to 90 seconds (processor limit: 60). A gateway timeout is **not** proof of
failure. Wait 90 seconds, reopen the preserved draft, then retry the same CSV.
Transient 429s can occur while the single admin execution is occupied. If a
pending input must be replaced, an operator must first verify the processor has
finished, review its logs and published week/season JSON, and resolve the pending
object explicitly; the portal deliberately cannot bypass that protection. Legacy
inputs without status metadata also require operator review before replacement.

Local checks cover mocked AWS authorization/storage/processor contracts and browser
OAuth/API simulations. Real managed login, invitation delivery, JWT rejection,
effective IAM, private-path denial, CloudFront `/admin/` routing and a real
submission remain post-deployment checks. No AWS resources were changed locally.

At a few commissioners and hundreds of monthly calls, expect incremental cost
well below $1/month, depending on account allowances and logging. Cognito's direct
sign-in allowance is currently 10,000 MAUs/account or organization; HTTP API
requests are approximately $1/million at the first tier, plus Lambda duration,
S3 requests/storage, CloudFront function invocations and logs. This is an estimate,
not a cap; see [Cognito pricing](https://aws.amazon.com/cognito/pricing/) and
[HTTP API pricing](https://aws.amazon.com/api-gateway/pricing/).
