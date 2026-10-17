# The server: one EC2 instance plus a separate EBS volume for the repos.
#
# Treat the instance as replaceable ("cattle, not pets"): everything on it is installed by the
# boot script, so rebuilding it is a `terraform apply`. The only state worth keeping is on the
# data volume, which outlives the instance and is what you snapshot before the demo.

# AWS publishes the latest Amazon Linux 2023 image ID under this public SSM parameter, so we never
# hard-code an AMI ID that goes stale. The instance ignores later image updates (see lifecycle),
# so AWS publishing a new image can't replace the server in the middle of the demo.
data "aws_ssm_parameter" "al2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

resource "aws_ebs_volume" "workspaces" {
  availability_zone = local.app_az # a volume can only attach to an instance in its own AZ
  size              = var.data_volume_gb
  type              = "gp3"
  encrypted         = true

  tags = { Name = "pineagent-workspaces" }
}

resource "aws_instance" "app" {
  ami                    = data.aws_ssm_parameter.al2023.value
  instance_type          = var.instance_type
  subnet_id              = local.app_subnet_id
  vpc_security_group_ids = [aws_security_group.app.id]
  iam_instance_profile   = aws_iam_instance_profile.app.name

  # IMDSv2 only: the metadata service (where the role's credentials come from) requires a session
  # token, which blocks the classic SSRF trick of making the server fetch its own credentials.
  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 2 # Docker containers add a network hop
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = 30
    encrypted   = true
  }

  # Runs once, on first boot (cloud-init). Changing it builds a fresh instance; the data volume
  # is reattached, so the repos survive.
  user_data = templatefile("${path.module}/bootstrap.sh.tftpl", {
    data_volume_id = aws_ebs_volume.workspaces.id
    domain_name    = var.domain_name
    caddy_version  = "2.11.7"
    release_bucket = aws_s3_bucket.releases.bucket
    region         = var.region
  })
  user_data_replace_on_change = true

  lifecycle {
    ignore_changes = [ami] # pick up a newer image deliberately: terraform apply -replace=aws_instance.app
  }

  tags = { Name = "pineagent-app" }
}

resource "aws_volume_attachment" "workspaces" {
  device_name = "/dev/sdf" # a request; Nitro instances expose it as an NVMe disk (see bootstrap)
  volume_id   = aws_ebs_volume.workspaces.id
  instance_id = aws_instance.app.id
}
