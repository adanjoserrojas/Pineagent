# HTTPS front door: an Application Load Balancer (ALB) with a free ACM certificate (LLD: ALB + ACM).
# Created only once var.domain_name is set.
#
#   browser ──https/wss :443──► ALB (TLS ends here) ──http :3001──► Node server
#
# The ALB holds the certificate, so the Node server never handles TLS. WebSockets work through an
# ALB as-is: the HTTP Upgrade request passes through and the connection stays open.

locals {
  https      = var.domain_name != ""
  route53    = local.https && var.route53_zone_id != ""
  alb_subnet = sort(data.aws_subnets.default.ids) # an ALB needs subnets in at least two AZs
}

# --- Certificate ------------------------------------------------------------------------------
# ACM issues the certificate only after you prove you control the domain, by publishing a CNAME
# record it gives you (DNS validation). With Route 53 we create that record; with any other DNS
# provider, copy it from the `certificate_validation_records` output, and `apply` waits for it.

resource "aws_acm_certificate" "api" {
  count             = local.https ? 1 : 0
  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true # a replacement cert is issued before the old one is removed
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = local.route53 ? {
    for o in aws_acm_certificate.api[0].domain_validation_options : o.domain_name => o
  } : {}
  zone_id = var.route53_zone_id
  name    = each.value.resource_record_name
  type    = each.value.resource_record_type
  records = [each.value.resource_record_value]
  ttl     = 300
}

resource "aws_acm_certificate_validation" "api" {
  count                   = local.https ? 1 : 0
  certificate_arn         = aws_acm_certificate.api[0].arn
  validation_record_fqdns = local.route53 ? [for r in aws_route53_record.cert_validation : r.fqdn] : null

  timeouts {
    create = "45m" # time to add the CNAME by hand when DNS isn't in Route 53
  }
}

# --- Load balancer ----------------------------------------------------------------------------

resource "aws_lb" "api" {
  count              = local.https ? 1 : 0
  name               = "pineagent"
  load_balancer_type = "application"
  subnets            = local.alb_subnet
  security_groups    = [aws_security_group.alb[0].id]

  # Close a connection after this long with no bytes either way. Socket.IO pings every 25 s, so
  # live sockets never hit it.
  idle_timeout = 120
}

resource "aws_lb_target_group" "api" {
  count    = local.https ? 1 : 0
  name     = "pineagent-api"
  port     = 3001
  protocol = "HTTP"
  vpc_id   = data.aws_vpc.default.id

  # The ALB only sends traffic to a target that answers this; it's also your quickest "is the
  # server up?" signal in the console.
  health_check {
    path                = "/health"
    matcher             = "200"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  # One server, so connection draining on deploys can be short.
  deregistration_delay = 10
}

resource "aws_lb_target_group_attachment" "api" {
  count            = local.https ? 1 : 0
  target_group_arn = aws_lb_target_group.api[0].arn
  target_id        = aws_instance.app.id
  port             = 3001
}

resource "aws_lb_listener" "https" {
  count             = local.https ? 1 : 0
  load_balancer_arn = aws_lb.api[0].arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06" # TLS 1.2+ only
  certificate_arn   = aws_acm_certificate_validation.api[0].certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api[0].arn
  }
}

resource "aws_lb_listener" "http_redirect" {
  count             = local.https ? 1 : 0
  load_balancer_arn = aws_lb.api[0].arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

# --- DNS name → load balancer -----------------------------------------------------------------
# An alias record is Route 53's free, AWS-aware CNAME: it follows the ALB's changing IPs. Outside
# Route 53, point a CNAME for domain_name at the `alb_dns_name` output instead.

resource "aws_route53_record" "api" {
  count   = local.route53 ? 1 : 0
  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_lb.api[0].dns_name
    zone_id                = aws_lb.api[0].zone_id
    evaluate_target_health = true
  }
}
