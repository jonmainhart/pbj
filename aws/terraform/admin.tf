# Public static shell; all commissioner operations require scoped access tokens.
resource "aws_cognito_user_pool" "admin" {
  name                     = "pbj-commissioners"
  user_pool_tier           = "ESSENTIALS"
  deletion_protection      = "ACTIVE"
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  admin_create_user_config { allow_admin_create_user_only = true }
  password_policy {
    minimum_length                   = 14
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = true
    temporary_password_validity_days = 3
  }
  lifecycle { prevent_destroy = true }
}
resource "aws_cognito_resource_server" "admin" {
  identifier   = "pbj"
  name         = "PBJ commissioner API"
  user_pool_id = aws_cognito_user_pool.admin.id
  scope {
    scope_name        = "admin"
    scope_description = "Manage commissioner picks"
  }
}
resource "aws_cognito_user_pool_client" "admin" {
  name                                 = "pbj-commissioner-spa"
  user_pool_id                         = aws_cognito_user_pool.admin.id
  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "pbj/admin"]
  supported_identity_providers         = ["COGNITO"]
  callback_urls                        = ["https://${aws_cloudfront_distribution.preview.domain_name}/admin/"]
  logout_urls                          = ["https://${aws_cloudfront_distribution.preview.domain_name}/admin/"]
  prevent_user_existence_errors        = "ENABLED"
  access_token_validity                = 30
  id_token_validity                    = 30
  refresh_token_validity               = 1
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }
  explicit_auth_flows = ["ALLOW_REFRESH_TOKEN_AUTH"]
  depends_on          = [aws_cognito_resource_server.admin]
}
resource "aws_cognito_user_pool_domain" "admin" {
  managed_login_version = 2
  domain                = "pbj-commissioners-${split(":", aws_iam_role.processor.arn)[4]}"
  user_pool_id          = aws_cognito_user_pool.admin.id
}
resource "aws_iam_role" "admin" {
  name = "pbj-admin-execution"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}
resource "aws_cloudwatch_log_group" "admin" {
  name              = "/aws/lambda/pbj-admin"
  retention_in_days = 30
}
resource "aws_iam_role_policy" "admin" {
  name = "pbj-private-commissioner-data"
  role = aws_iam_role.admin.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.admin.arn}:*" },
      { Effect = "Allow", Action = "s3:ListBucket", Resource = "arn:aws:s3:::${local.data_bucket}", Condition = { StringLike = { "s3:prefix" = ["data/", "data/*"] } } },
      {
        Sid      = "PrivateCSVExistence"
        Effect   = "Allow"
        Action   = "s3:ListBucket"
        Resource = "arn:aws:s3:::${local.data_bucket}"
        Condition = { StringLike = { "s3:prefix" = [
          "incoming/????/drafts/week??.csv",
          "incoming/????/week??.csv"
        ] } }
      },
      { Effect = "Allow", Action = "s3:GetObject", Resource = "arn:aws:s3:::${local.data_bucket}/data/*" },
      { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject"], Resource = ["arn:aws:s3:::${local.data_bucket}/incoming/????/drafts/week??.csv", "arn:aws:s3:::${local.data_bucket}/incoming/????/week??.csv"] },
      { Effect = "Allow", Action = "s3:DeleteObject", Resource = "arn:aws:s3:::${local.data_bucket}/incoming/????/drafts/week??.csv" },
      { Effect = "Allow", Action = "lambda:InvokeFunction", Resource = aws_lambda_function.processor.arn }
    ]
  })
}
resource "aws_lambda_function" "admin" {
  function_name                  = "pbj-admin"
  role                           = aws_iam_role.admin.arn
  runtime                        = "python3.14"
  handler                        = "aws.admin.lambda_handler"
  filename                       = "${path.module}/bootstrap.zip"
  timeout                        = 90
  memory_size                    = 256
  reserved_concurrent_executions = 1
  environment {
    variables = {
      PBJ_DATA_BUCKET        = local.data_bucket
      PBJ_DATA_PREFIX        = local.data_prefix
      PBJ_ADMIN_CLIENT_ID    = aws_cognito_user_pool_client.admin.id
      PBJ_PROCESSOR_FUNCTION = aws_lambda_function.processor.function_name
    }
  }
  depends_on = [aws_iam_role_policy.admin, aws_cloudwatch_log_group.admin]
  lifecycle {
    prevent_destroy = true
    ignore_changes  = [filename, source_code_hash]
  }
}
resource "aws_apigatewayv2_api" "admin" {
  name          = "pbj-admin"
  protocol_type = "HTTP"
  cors_configuration {
    allow_origins = ["https://${aws_cloudfront_distribution.preview.domain_name}"]
    allow_methods = ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
    allow_headers = ["authorization", "content-type"]
    max_age       = 300
  }
}
resource "aws_apigatewayv2_authorizer" "admin" {
  api_id           = aws_apigatewayv2_api.admin.id
  name             = "commissioner-jwt"
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  jwt_configuration {
    audience = [aws_cognito_user_pool_client.admin.id]
    issuer   = "https://cognito-idp.us-east-2.amazonaws.com/${aws_cognito_user_pool.admin.id}"
  }
}
resource "aws_apigatewayv2_integration" "admin" {
  api_id                 = aws_apigatewayv2_api.admin.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.admin.invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 30000
}
resource "aws_apigatewayv2_route" "admin" {
  for_each             = toset(["GET /schedules", "POST /schedules/next", "GET /weeks/{season}/{week}", "POST /weeks/{season}/{week}/validate", "PUT /weeks/{season}/{week}/draft", "DELETE /weeks/{season}/{week}/draft", "POST /weeks/{season}/{week}/submit"])
  api_id               = aws_apigatewayv2_api.admin.id
  route_key            = each.value
  target               = "integrations/${aws_apigatewayv2_integration.admin.id}"
  authorization_type   = "JWT"
  authorizer_id        = aws_apigatewayv2_authorizer.admin.id
  authorization_scopes = ["pbj/admin"]
}
resource "aws_apigatewayv2_stage" "admin" {
  api_id      = aws_apigatewayv2_api.admin.id
  name        = "$default"
  auto_deploy = true
  default_route_settings {
    throttling_burst_limit = 5
    throttling_rate_limit  = 2
  }
}
resource "aws_lambda_permission" "admin" {
  statement_id  = "PBJAdminGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.admin.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.admin.execution_arn}/*/*"
}
resource "aws_s3_object" "admin_config" {
  bucket        = aws_s3_bucket.preview.id
  key           = "assets/admin-config.json"
  content_type  = "application/json"
  cache_control = "no-store"
  content = jsonencode({
    api         = aws_apigatewayv2_api.admin.api_endpoint
    clientId    = aws_cognito_user_pool_client.admin.id
    domain      = "https://${aws_cognito_user_pool_domain.admin.domain}.auth.us-east-2.amazoncognito.com"
    redirectUri = "https://${aws_cloudfront_distribution.preview.domain_name}/admin/"
  })
}
resource "aws_cloudfront_function" "admin" {
  name    = "pbj-admin-index"
  runtime = "cloudfront-js-2.0"
  publish = true
  code    = "function handler(event) { var r = event.request; if (r.uri === '/admin' || r.uri === '/admin/') r.uri = '/admin/index.html'; return r; }"
}
output "admin_user_pool_id" { value = aws_cognito_user_pool.admin.id }
output "admin_api_url" { value = aws_apigatewayv2_api.admin.api_endpoint }

resource "aws_cognito_managed_login_branding" "admin" {
  user_pool_id                = aws_cognito_user_pool.admin.id
  client_id                   = aws_cognito_user_pool_client.admin.id
  use_cognito_provided_values = true
  depends_on                  = [aws_cognito_user_pool_domain.admin]
}
