# HTTPS without a load balancer. Created only once var.domain_name is set.
#
#   browser ─https/wss :443─► Elastic IP ─► Caddy on the instance ─► 127.0.0.1:3001 Node
#           ─http :80──────►              (Let's Encrypt challenge, then redirect to https)
#
# Caddy gets and renews a free Let's Encrypt certificate by itself. (ACM certificates can't be used
# here: AWS only installs them on its own front doors, like load balancers and CloudFront.) The
# LLD's ALB + ACM costs ~$18/month and adds a hop; for one server at a hackathon this is enough.
# The tradeoff: the instance itself faces the internet on 80/443, so Caddy is the only thing
# listening there and Node binds to localhost only.

locals {
  https = var.domain_name != ""
}

# A fixed public address for the DNS record. An instance's own public IP changes whenever it is
# stopped or replaced; an Elastic IP stays and is simply re-associated with the new instance.
resource "aws_eip" "api" {
  count  = local.https ? 1 : 0
  domain = "vpc"

  tags = { Name = "pineagent-api" }
}

resource "aws_eip_association" "api" {
  count         = local.https ? 1 : 0
  allocation_id = aws_eip.api[0].id
  instance_id   = aws_instance.app.id
}

resource "aws_vpc_security_group_ingress_rule" "app_https" {
  count             = local.https ? 1 : 0
  security_group_id = aws_security_group.app.id
  description       = "HTTPS and WSS, to Caddy"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

# Let's Encrypt proves you control the domain by fetching a token over plain HTTP on port 80.
# Caddy answers that, and redirects every other http:// request to https://.
resource "aws_vpc_security_group_ingress_rule" "app_http" {
  count             = local.https ? 1 : 0
  security_group_id = aws_security_group.app.id
  description       = "HTTP: ACME challenge and redirect to HTTPS" # no apostrophes: AWS rejects them here
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = "0.0.0.0/0"
}
