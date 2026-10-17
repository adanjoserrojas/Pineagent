# Where deploys put builds for the server to pull. Your laptop uploads (your IAM user); the server's
# role can only download. Nothing in a release is secret: config is non-secret and the Auth0 key is
# generated on the server's own data volume.
#
#   s3://<bucket>/releases/<sha>.tgz   one build (expires after 30 days)
#   s3://<bucket>/latest.txt           the sha a freshly built instance should install

data "aws_caller_identity" "me" {}

resource "aws_s3_bucket" "releases" {
  # Bucket names are global across all of AWS, so include the account id to avoid collisions.
  bucket = "pineagent-releases-${data.aws_caller_identity.me.account_id}"
}

# Belt and braces: no ACL or bucket policy can ever make these objects public.
resource "aws_s3_bucket_public_access_block" "releases" {
  bucket                  = aws_s3_bucket.releases.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "releases" {
  bucket = aws_s3_bucket.releases.id
  rule {
    object_ownership = "BucketOwnerEnforced" # ACLs off; access is decided by IAM only
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "releases" {
  bucket = aws_s3_bucket.releases.id
  rule {
    id     = "expire-old-releases"
    status = "Enabled"
    filter {
      prefix = "releases/"
    }
    expiration {
      days = 30
    }
  }
}

# The server may read releases, nothing else in S3.
data "aws_iam_policy_document" "read_releases" {
  statement {
    actions = ["s3:GetObject"]
    resources = [
      "${aws_s3_bucket.releases.arn}/releases/*",
      "${aws_s3_bucket.releases.arn}/latest.txt",
    ]
  }
}

resource "aws_iam_role_policy" "read_releases" {
  name   = "read-releases"
  role   = aws_iam_role.app.id
  policy = data.aws_iam_policy_document.read_releases.json
}
