# Network: the account's default VPC, and the server's firewall (security group).
#
# Hackathon shortcut: the default VPC's subnets are public, so the instance gets a public IP for
# OUTBOUND traffic (GitHub, npm, Bedrock) without paying ~$32/month for a NAT gateway. Inbound is
# still closed: the security group below decides what may connect. Production would put the
# instance in a private subnet behind a load balancer.

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
  filter {
    name   = "default-for-az"
    values = ["true"]
  }
}

data "aws_subnet" "default" {
  for_each = toset(data.aws_subnets.default.ids)
  id       = each.value
}

# Not every instance type exists in every Availability Zone; pick a subnet in one that has it.
data "aws_ec2_instance_type_offerings" "here" {
  location_type = "availability-zone"
  filter {
    name   = "instance-type"
    values = [var.instance_type]
  }
}

locals {
  usable_subnets = sort([
    for s in data.aws_subnet.default : s.id
    if contains(data.aws_ec2_instance_type_offerings.here.locations, s.availability_zone)
  ])
  app_subnet_id = local.usable_subnets[0]
  app_az        = data.aws_subnet.default[local.app_subnet_id].availability_zone
}

# --- Security groups ----------------------------------------------------------------------------
# A security group is a stateful firewall attached to a resource: replies to allowed traffic are
# allowed automatically. Start closed; each rule below is one deliberate opening.

resource "aws_security_group" "app" {
  name        = "pineagent-app"
  description = "Pineagent server"
  vpc_id      = data.aws_vpc.default.id
}

# The server needs the internet for GitHub, npm, Docker images and AWS APIs (SSM, Bedrock).
resource "aws_vpc_security_group_egress_rule" "app_out" {
  security_group_id = aws_security_group.app.id
  description       = "All outbound"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# No inbound rule for port 22: you get a shell through SSM Session Manager instead, which needs no
# open port and logs who connected. Ports 80 and 443 open in https.tf once there's a domain.
