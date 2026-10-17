# Printed after `apply` (and any time with `terraform output`).

output "instance_id" {
  value = aws_instance.app.id
}

output "availability_zone" {
  value = local.app_az
}

output "shell" {
  description = "Open a shell on the server (needs the Session Manager plugin)."
  value       = "aws ssm start-session --profile ${var.aws_profile} --region ${var.region} --target ${aws_instance.app.id}"
}

output "public_ip" {
  description = "Add an A record for domain_name pointing here."
  value       = local.https ? aws_eip.api[0].public_ip : null
}

output "url" {
  value = local.https ? "https://${var.domain_name}" : null
}

output "release_bucket" {
  description = "Where infra/deploy.sh uploads builds."
  value       = aws_s3_bucket.releases.bucket
}

output "state_tables" {
  description = "DynamoDB tables for locks and file versions (names go in deploy/production.env)"
  value       = { for k, t in aws_dynamodb_table.state : k => t.name }
}
