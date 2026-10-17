# Inputs. Set them in terraform.tfvars (gitignored); terraform.tfvars.example shows the shape.

variable "aws_profile" {
  description = "AWS CLI profile for the Pineagent account (aws configure sso / aws configure --profile ...)."
  type        = string
}

variable "region" {
  description = "Everything lives in this one region."
  type        = string
  default     = "us-east-2"
}

variable "instance_type" {
  description = "LLD: one m7i.xlarge (4 vCPU, 16 GiB) is the single authority. About $0.20/hour."
  type        = string
  default     = "m7i.xlarge"
}

variable "data_volume_gb" {
  description = "Size of the EBS volume mounted at /workspaces (the cloned repos)."
  type        = number
  default     = 50
}

variable "domain_name" {
  description = "Public hostname for HTTPS, e.g. api.example.com. Point its DNS A record at the public_ip output. Empty = no HTTPS yet (phase 1)."
  type        = string
  default     = ""
}

variable "budget_email" {
  description = "Where AWS Budgets sends cost alerts. Empty = no budget (not recommended)."
  type        = string
  default     = ""
}

variable "budget_usd" {
  description = "Monthly budget for the whole account; alerts at 80% actual and 100% forecast."
  type        = number
  default     = 25
}
