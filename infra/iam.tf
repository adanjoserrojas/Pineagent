# The server's identity. An instance profile hands the EC2 instance an IAM role, and the AWS SDK
# on the box fetches short-lived credentials for it from the instance metadata service. No access
# keys are ever stored on the server, so there are none to leak.
#
# Least privilege: Session Manager here, plus one policy per thing the server needs, each scoped
# to the exact resources: release downloads (releases.tf), the two state tables (dynamodb.tf).

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "app" {
  name               = "pineagent-app"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

# Lets you open a shell with `aws ssm start-session` instead of SSH.
resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.app.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "app" {
  name = "pineagent-app"
  role = aws_iam_role.app.name
}
