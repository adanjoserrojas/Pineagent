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

output "alb_dns_name" {
  description = "Point a CNAME for domain_name here when DNS isn't in Route 53."
  value       = local.https ? aws_lb.api[0].dns_name : null
}

output "certificate_validation_records" {
  description = "Add these CNAMEs at your DNS provider so ACM can issue the certificate (not needed with Route 53)."
  value = local.https && !local.route53 ? [
    for o in aws_acm_certificate.api[0].domain_validation_options : {
      name  = o.resource_record_name
      type  = o.resource_record_type
      value = o.resource_record_value
    }
  ] : []
}

output "url" {
  value = local.https ? "https://${var.domain_name}" : null
}
