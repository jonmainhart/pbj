resource "aws_s3_bucket" "preview" {
  bucket = "pbj-preview-jm26"
  lifecycle { prevent_destroy = true }
}

resource "aws_s3_bucket_public_access_block" "preview" {
  bucket                  = aws_s3_bucket.preview.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_cloudfront_origin_access_control" "preview" {
  name                              = "pbj-preview"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_response_headers_policy" "data" {
  name = "pbj-preview-data-no-store"
  custom_headers_config {
    items {
      header   = "Cache-Control"
      value    = "no-store"
      override = true
    }
  }
}

resource "aws_cloudfront_distribution" "preview" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "PBJ public AWS preview"
  default_root_object = "index.html"
  price_class         = "PriceClass_100"

  aliases = ["www.pbjfootball.com", "pbjfootball.com"]

  origin {
    domain_name              = aws_s3_bucket.preview.bucket_regional_domain_name
    origin_id                = "static"
    origin_access_control_id = aws_cloudfront_origin_access_control.preview.id
  }
  origin {
    domain_name              = "${local.data_bucket}.s3.us-east-2.amazonaws.com"
    origin_id                = "data"
    origin_access_control_id = aws_cloudfront_origin_access_control.preview.id
  }

  # Managed CachingDisabled: simple, predictable freshness for unversioned files.
  default_cache_behavior {
    target_origin_id       = "static"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    compress               = true
    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.admin.arn
    }
  }
  ordered_cache_behavior {
    path_pattern               = "/data/*"
    target_origin_id           = "data"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    response_headers_policy_id = aws_cloudfront_response_headers_policy.data.id
    compress                   = true
  }
  # Avoid caching missing rollover manifests/weeks (S3 has a minimum of 1 second).
  custom_error_response {
    error_code            = 403
    error_caching_min_ttl = 0
  }
  custom_error_response {
    error_code            = 404
    error_caching_min_ttl = 0
  }
  restrictions {
    geo_restriction { restriction_type = "none" }
  }
  viewer_certificate {
    acm_certificate_arn      = "arn:aws:acm:us-east-1:972224212140:certificate/8383854a-beb8-46b0-b339-62e1ebea1ad1"
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
  lifecycle { prevent_destroy = true }
}

resource "aws_s3_bucket_policy" "preview" {
  bucket = aws_s3_bucket.preview.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "PBJPreviewStaticRead"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.preview.arn}/*"
      Condition = { StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.preview.arn } }
    }]
  })
  depends_on = [aws_s3_bucket_public_access_block.preview]
}

# GetBucketPolicy confirmed NoSuchBucketPolicy; Terraform owns this policy.
resource "aws_s3_bucket_policy" "preview_data" {
  bucket = local.data_bucket
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "PBJPreviewDataRead"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "arn:aws:s3:::${local.data_bucket}/data/*"
      Condition = { StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.preview.arn } }
    }]
  })
  lifecycle { prevent_destroy = true }
}

output "preview_hostname" {
  value = aws_cloudfront_distribution.preview.domain_name
}
output "preview_distribution_id" {
  value = aws_cloudfront_distribution.preview.id
}
output "preview_bucket" {
  value = aws_s3_bucket.preview.id
}
