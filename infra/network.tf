# Network: the account's default VPC, and two firewalls (security groups).
#
# Hackathon shortcut: the default VPC's subnets are public, so the instance gets a public IP for
# OUTBOUND traffic (GitHub, npm, Bedrock) without paying ~$32/month for a NAT gateway. Inbound is
# still closed: the security groups below decide what may connect, and nothing may reach the
# instance except the load balancer. Production would put the instance in a private subnet.

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
  description = "Pineagent Node server: reachable only from the load balancer"
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
# open port and logs who connected. The only way in is :3001 from the load balancer.
resource "aws_vpc_security_group_ingress_rule" "app_from_alb" {
  count                        = local.https ? 1 : 0
  security_group_id            = aws_security_group.app.id
  description                  = "Node server, from the load balancer only"
  ip_protocol                  = "tcp"
  from_port                    = 3001
  to_port                      = 3001
  referenced_security_group_id = aws_security_group.alb[0].id
}

resource "aws_security_group" "alb" {
  count       = local.https ? 1 : 0
  name        = "pineagent-alb"
  description = "Pineagent load balancer: HTTPS from anywhere"
  vpc_id      = data.aws_vpc.default.id
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  count             = local.https ? 1 : 0
  security_group_id = aws_security_group.alb[0].id
  description       = "HTTPS and WSS"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

# Port 80 exists only to redirect people who type http:// to https://.
resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  count             = local.https ? 1 : 0
  security_group_id = aws_security_group.alb[0].id
  description       = "HTTP, redirected to HTTPS"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_app" {
  count                        = local.https ? 1 : 0
  security_group_id            = aws_security_group.alb[0].id
  description                  = "Forward to the Node server"
  ip_protocol                  = "tcp"
  from_port                    = 3001
  to_port                      = 3001
  referenced_security_group_id = aws_security_group.app.id
}
