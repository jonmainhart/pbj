terraform {
  required_version = "= 1.17.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
  backend "s3" {
    bucket       = "pbj-data-jm26"
    key          = "terraform/pbj.tfstate"
    region       = "us-east-2"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = "us-east-2"
}

locals {
  data_bucket         = "pbj-data-jm26"
  data_prefix         = "data/"
  input_prefix        = "incoming/"
  api_key_parameter   = "/pbj/balldontlie-api-key"
  season              = 2026
  week1_creation_date = "2026-09-08"
}

resource "aws_iam_role" "processor" {
  name = "pbj-lambda-execution"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  lifecycle { prevent_destroy = true }
}

resource "aws_cloudwatch_log_group" "processor" {
  name              = "/aws/lambda/pbj-processor"
  retention_in_days = 30
  lifecycle { prevent_destroy = true }
}

resource "aws_iam_role_policy" "processor" {
  name = "pbj-operational-data"
  role = aws_iam_role.processor.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "ssm:GetParameter"
        Resource = "arn:aws:ssm:us-east-2:${split(":", aws_iam_role.processor.arn)[4]}:parameter${local.api_key_parameter}"
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.processor.arn}:*"
      },
      {
        Effect    = "Allow"
        Action    = ["s3:ListBucket"]
        Resource  = "arn:aws:s3:::${local.data_bucket}"
        Condition = { StringLike = { "s3:prefix" = [local.data_prefix, "${local.data_prefix}*"] } }
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "arn:aws:s3:::${local.data_bucket}/${local.input_prefix}*/week*.csv"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject"]
        Resource = "arn:aws:s3:::${local.data_bucket}/${local.data_prefix}*"
      }
    ]
  })
}

resource "aws_lambda_function" "processor" {
  function_name                  = "pbj-processor"
  role                           = aws_iam_role.processor.arn
  runtime                        = "python3.14"
  handler                        = "lambda_function.lambda_handler"
  architectures                  = ["x86_64"]
  reserved_concurrent_executions = 1
  timeout                        = 60
  memory_size                    = 256
  filename                       = "${path.module}/bootstrap.zip"
  environment {
    variables = {
      PBJ_DATA_BUCKET         = local.data_bucket
      PBJ_DATA_PREFIX         = local.data_prefix
      PBJ_INPUT_PREFIX        = local.input_prefix
      PBJ_API_KEY_PARAMETER   = local.api_key_parameter
      PBJ_SEASON              = tostring(local.season)
      PBJ_WEEK1_CREATION_DATE = local.week1_creation_date
    }
  }
  depends_on = [aws_iam_role_policy.processor, aws_cloudwatch_log_group.processor]
  lifecycle {
    prevent_destroy = true
    ignore_changes  = [filename, source_code_hash]
  }
}

output "function_name" {
  value = aws_lambda_function.processor.function_name
}

resource "aws_iam_role" "scheduler" {
  name = "pbj-scheduler-execution"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = split(":", aws_lambda_function.processor.arn)[4] }
        ArnEquals    = { "aws:SourceArn" = "arn:aws:scheduler:us-east-2:${split(":", aws_lambda_function.processor.arn)[4]}:schedule-group/default" }
      }
    }]
  })
  lifecycle { prevent_destroy = true }
}

resource "aws_iam_role_policy" "scheduler" {
  name = "pbj-invoke-processor"
  role = aws_iam_role.scheduler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "lambda:InvokeFunction"
      Resource = aws_lambda_function.processor.arn
    }]
  })
}

resource "aws_scheduler_schedule" "create_week" {
  name                         = "pbj-create-week"
  state                        = "ENABLED"
  schedule_expression          = "cron(0 8 ? * TUE *)"
  schedule_expression_timezone = "America/New_York"
  flexible_time_window { mode = "OFF" }
  target {
    arn      = aws_lambda_function.processor.arn
    role_arn = aws_iam_role.scheduler.arn
    input    = jsonencode({ action = "create_week", scheduled_time = "<aws.scheduler.scheduled-time>" })
    retry_policy {
      maximum_event_age_in_seconds = 300
      maximum_retry_attempts       = 2
    }
  }
  depends_on = [aws_iam_role_policy.scheduler]
  lifecycle { prevent_destroy = true }
}

resource "aws_scheduler_schedule" "poll_games" {
  name                         = "pbj-poll-games"
  state                        = "ENABLED"
  schedule_expression          = "cron(2/5 * * * ? *)"
  schedule_expression_timezone = "America/New_York"
  flexible_time_window { mode = "OFF" }
  target {
    arn      = aws_lambda_function.processor.arn
    role_arn = aws_iam_role.scheduler.arn
    input    = jsonencode({ action = "poll_games" })
    retry_policy {
      maximum_event_age_in_seconds = 300
      maximum_retry_attempts       = 0
    }
  }
  depends_on = [aws_iam_role_policy.scheduler]
  lifecycle { prevent_destroy = true }
}
