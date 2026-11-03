# PBJ AWS operations

GitHub Pages on `main` remains production. The `test/aws-upgrade` branch provides an independent AWS preview with a commissioner portal; production cutover remains subject to [parallel validation #71](https://github.com/jonmainhart/pbj/issues/71) and [cutover #72](https://github.com/jonmainhart/pbj/issues/72).

## Deployment and infrastructure

A push to `test/aws-upgrade` or a manual run of [AWS infrastructure and deployment](../.github/workflows/terraform.yml) runs quality checks, validates Terraform, plans and applies an allowlisted plan, and then calls [Deploy AWS application](../.github/workflows/deploy-aws.yml). Deployment packages the installed `pbj` package with the reusable scripts and both Lambda handlers, checks the staged imports, deploys `pbj-processor` and `pbj-admin`, verifies their code hashes, builds the site, and uploads static preview assets. Review changes and workflow results before relying on the deployment; the push itself triggers it.

Terraform configuration is in [aws/terraform](terraform/). Its S3 backend uses `s3://pbj-data-jm26/terraform/pbj.tfstate` in `us-east-2`, encryption, and S3 lockfiles. GitHub Actions initializes the remote backend and applies the saved plan after [aws/check-plan.py](check-plan.py) approves it. The guard rejects unallowlisted and destructive changes except its narrowly defined recovery cases; review the actual plan and guard before changes. Terraform owns the managed resources; avoid manual infrastructure changes that cause drift.

GitHub environments `pbj-aws-infra` and `pbj-aws-deploy` hold the scoped IAM-user access-key secrets used by the respective workflows. AWS deployment uses these IAM users, not the earlier proposed AWS OIDC workflow. Permission templates are in [aws/iam](iam/); update their resource identifiers and provision permissions through an authorized operator when infrastructure changes require it. Commissioner provisioning is a separate operator permission. Keep keys and provider credentials out of Git and public artifacts.

For offline local Terraform checks:

```bash
bash aws/check-terraform.sh
```

The script checks formatting and validates with locally installed providers; if providers are absent it initializes with `-backend=false` and a read-only lockfile, without connecting to remote state. The normal workflow handles remote initialization and apply. To query outputs as an authorized operator, use an initialized remote-state working directory and the appropriate AWS credentials:

```bash
terraform -chdir=aws/terraform output -raw preview_hostname
terraform -chdir=aws/terraform output -raw admin_user_pool_id
```

## Runtime and publication boundaries

- The processor's private bucket is `pbj-data-jm26`. Public operational JSON lives under `data/`; commissioner drafts and submitted CSVs live under `incoming/`; Terraform state lives under `terraform/`.
- `pbj-processor` uses the existing scripts to create schedules, poll, import, score, and aggregate. EventBridge Scheduler creates the week Tuesday at 8:00 AM Eastern and invokes polling every five minutes; the processor checks whether polling is needed. The configured season and first creation date are in [main.tf](terraform/main.tf). The BALLDONTLIE key is read from the configured SSM parameter; do not print its value into logs or documentation.
- `pbj-admin` verifies API Gateway Cognito JWT claims and scope, reads schedules, manages private CSVs and announcements, and invokes the processor. Each Lambda has reserved concurrency of one. Do not run manual imports concurrently with portal submissions.
- The public HTTPS CloudFront preview serves static assets from private `pbj-preview-jm26` and `/data/*` from the private operational bucket. The CloudFront URL itself is public; origin access controls do not restrict viewers. Only `data/*` is exposed from the operational bucket, never `incoming/*` or `terraform/*`.
- Static uploads do not sync or delete objects and exclude `data/`, CSVs, `CNAME`, and Terraform-owned `assets/admin-config.json`. Removed static assets can remain in the bucket. JSON uses `no-store`; static assets revalidate. The portal configuration contains public API/OAuth settings, not a client secret.

## Commissioner access and operation

An authorized operator provisions each commissioner in the dedicated Cognito pool; self-registration is disabled. Obtain the pool ID and preview hostname from Terraform outputs, then use an operator identity with permission for that pool:

```bash
aws cognito-idp admin-create-user --region us-east-2 \
  --user-pool-id POOL_ID --username commissioner@example.com \
  --user-attributes Name=email,Value=commissioner@example.com \
  --desired-delivery-mediums EMAIL
```

Cognito emails a temporary password. Only the preview `/admin/` URL is configured for login and logout. All provisioned accounts have commissioner access. Access and refresh tokens remain in memory; a page reload requires sign-in. Access tokens last 30 minutes, so disabling an account does not immediately invalidate an already issued token. The portal uses authorization code and PKCE; API routes require `pbj/admin` and the admin Lambda checks token identity, type, and client.

The portal opens a private draft if present, otherwise published picks or an empty schedule. Edits are retained immediately on the device and autosaved to the shared private draft after inactivity, using ETags for conflict protection. Device recovery is scoped to the verified account and week, offered for explicit review, and is not encrypted; use a trusted browser profile. Browser storage can be unavailable or cleared. Multiple tabs can overwrite the same device recovery copy, although server ETags still detect conflicts.

**Save Draft** remains private. **Submit Picks** validates and confirms the input, saves the draft, and invokes processing; published picks require explicit acknowledgement before editing and resubmission. **Reopen Saved Draft**, **Revert Changes**, and **Delete Draft** have distinct effects: deletion removes only the private draft, not submitted input or published results. Resolve conflicts by reopening and reviewing rather than overwriting another session. The Announcements view separately publishes two optional messages and links; announcement edits have no device draft recovery.

**Create Week N** prepares only the next eligible week and does not publish its manifest entry. The scheduled Tuesday invocation reuses a prepared week and publishes it at the scheduled time. After an uncertain creation, refresh the catalog before trying again.

Private input paths are `incoming/<season>/drafts/weekNN.csv` for drafts and `incoming/<season>/weekNN.csv` for submitted input; published results are `data/<season>/weekNN.json` and `data/<season>/season.json`. Manual CSV import uses the submitted input path and the processor's `import_picks` action; uploading a CSV alone does not trigger processing.

## Troubleshooting and recovery

Inspect the GitHub Actions run first for deployment or Terraform failures. With an authorized AWS profile, inspect Lambda logs without exposing credentials:

```bash
aws logs tail /aws/lambda/pbj-admin --region us-east-2 --profile pbj --since 1h
aws logs tail /aws/lambda/pbj-processor --region us-east-2 --profile pbj --since 1h
```

For a read-only processor scoring check, invoke `score_week` without `write` (the default is false), and inspect both the CLI response for `FunctionError` and the result file:

```bash
aws lambda invoke --profile pbj --region us-east-2 --function-name pbj-processor \
  --cli-binary-format raw-in-base64-out \
  --payload '{"action":"score_week","season":2026,"week":1}' /tmp/pbj-result.json
cat /tmp/pbj-result.json
```

A portal gateway timeout does not prove submission failed: API Gateway can time out after 30 seconds while the admin Lambda can run for 90 seconds. Wait at least 90 seconds, inspect both Lambda logs and the published week/season data, reopen the preserved draft, and retry the **same CSV**. A retry repairs partial publication. Transient 429 responses can mean the single admin execution is occupied; wait and retry.

A different CSV cannot replace a submitted object marked `pending` or with missing legacy status. Before an operator resolves such a case, confirm processing has stopped, review the existing input and published outputs, and preserve a copy. Do not bypass the conditional-write guard or run another import while the first outcome is uncertain. Inspect status and ETag without printing the CSV:

```bash
aws s3api head-object --profile pbj --region us-east-2 --bucket pbj-data-jm26 \
  --key incoming/2026/week01.csv --query '{state:Metadata.state,etag:ETag}'
```

On draft conflict, reopen the saved draft and review the device copy before saving. If device recovery is unavailable, keep the page open and save to the private server draft. An uncertain initial save must be reconciled with the server before reverting; do not assume it failed. If sign-in fails, retry sign-in. If portal loading fails after authentication, retry loading using the current session.

For a bad application release, use a reviewed correction or rollback of application source through the normal branch deployment workflow, and verify both Lambda hashes and the static preview afterward. This uploader does not delete stale static objects. Do not roll back operational data or Terraform state blindly: inspect current objects, logs, and available backups or versions, then use conditional recovery appropriate to the incident. GitHub Pages remains the production fallback until an authorized cutover.

## Operational verification and cost

After deployment, check the preview dashboard, `/admin/`, generated document cards, manifest and week/season JSON over HTTPS. Verify real commissioner login, authorization rejection, submission and recovery, and that direct anonymous S3 access, `/incoming/`, and `/terraform/` are denied. Compare AWS and Pages results separately, including desktop and iOS resume behavior. Local mocked tests do not prove deployed IAM, Cognito, CloudFront, or scheduler behavior; complete the operational checks in #71 before cutover.

Keep public-access blocks, scoped IAM, private CSVs, state protection, and the existing deployment boundaries intact. Monitor CloudWatch logs, S3 requests/storage and versions, CloudFront traffic, Lambda execution, and Cognito/API usage against the account's actual allowances and billing alerts; usage and pricing change, so estimates are not spending caps.
