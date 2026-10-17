# Restart recovery for the editor (contracts/SOCKET_LOCKS_AND_FILES.md, "Restart recovery").
# The Node process keeps locks, file versions and editors in memory and writes each change here
# before acknowledging it, so a deploy or crash doesn't drop who holds what.
#
#   pineagent-locks  PK room  SK path   one item per editor lock
#   pineagent-files  PK room  SK path   version + who edited it since the last commit
#
# On-demand billing: you pay per request (about $1.25 per million writes), nothing while idle.
# DynamoDB deletes items whose `ttl` (epoch seconds) has passed, which cleans up abandoned branches.
# Point-in-time backups are off: this is state a restart reads once, not data anyone needs back.

locals {
  tables = {
    locks = "pineagent-locks"
    files = "pineagent-files"
  }
}

resource "aws_dynamodb_table" "state" {
  for_each     = local.tables
  name         = each.value
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "room"
  range_key    = "path"

  attribute {
    name = "room"
    type = "S"
  }
  attribute {
    name = "path"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }
}

# The server may read and write items in exactly these two tables. No scans, no table changes.
data "aws_iam_policy_document" "state_tables" {
  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query"]
    resources = [for t in aws_dynamodb_table.state : t.arn]
  }
}

resource "aws_iam_role_policy" "state_tables" {
  name   = "state-tables"
  role   = aws_iam_role.app.id
  policy = data.aws_iam_policy_document.state_tables.json
}
