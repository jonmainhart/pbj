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
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.processor.arn}:*"
      },
      {
        Effect    = "Allow"
        Action    = ["s3:ListBucket"]
        Resource  = "arn:aws:s3:::pbj-data-jm26"
        Condition = { StringLike = { "s3:prefix" = ["data/", "data/*"] } }
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject"]
        Resource = "arn:aws:s3:::pbj-data-jm26/data/*"
      }
    ]
  })
}

resource "aws_lambda_function" "processor" {
  function_name = "pbj-processor"
  role          = aws_iam_role.processor.arn
  runtime       = "python3.14"
  handler       = "lambda_function.lambda_handler"
  architectures = ["x86_64"]
  timeout       = 60
  memory_size   = 256
  filename      = "${path.module}/bootstrap.zip"
  environment {
    variables = {
      PBJ_DATA_BUCKET = "pbj-data-jm26"
      PBJ_DATA_PREFIX = "data/"
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
