# Which Terraform and which provider plugins this code expects. `terraform init` downloads the
# providers and pins their exact versions in .terraform.lock.hcl, which IS committed so everyone
# (and CI) gets the same build of the AWS provider.
terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # State lives in a local file (terraform.tfstate) for the hackathon: one person applies. A team
  # would move it to an S3 backend with locking so two applies can't race. Never commit state; it
  # records every attribute of every resource, secrets included.
}

provider "aws" {
  # Credentials come from your named AWS CLI profile, never from this code.
  profile = var.aws_profile
  region  = var.region

  # Stamped on every resource, so the bill and the console can be filtered to this project.
  default_tags {
    tags = {
      Project   = "pineagent"
      Owner     = "se2"
      ManagedBy = "terraform"
    }
  }
}
