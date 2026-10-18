# Opus 4.6 access — prepared, not deployed

SE1 / low-level design boxes 7–8. This additive CDK stack attaches one inline
policy to the existing Terraform-managed `pineagent-app` EC2 role. It does not
create roles, users, access keys, hosts, tables, or a second owner for Terraform
resources. The application uses its instance role, never root credentials.

Run `npm ci`, `npm test`, and `npm run synth` here for offline validation.
The CloudFormation template permits only invocation/streaming of the US Opus 4.6
inference profile and its three foundation-model targets, with a profile condition
on the targets. No model listing, policy administration, or wildcard model access.

Before deployment the owner must explicitly approve deployment and confirm the
account, existing role, and gateway region (default `us-east-2`, matching existing
Terraform). Deployment must use a least-privilege operator, not root. Inspect the
change set; it must contain only this policy. CloudFormation/CDK deployment and
bootstrap permissions are deliberately not part of the runtime policy.

Then verify role assumption on the actual host and perform one authorized,
bounded Bedrock request; successful synthesis does not establish model access,
quota, marketplace entitlement, SCP permission, or successful inference.
Rollback removes only this policy through its owning CloudFormation stack.

References: [CDK IAM policy](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_iam.CfnPolicy.html),
[Bedrock cross-region profiles](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-prereq.html).
