# Opus 4.6 and router-secret access

SE1 / low-level design boxes 7–8. This additive CDK stack attaches one inline
model policy and up to two exact-ARN secret-read policies to the existing Terraform-managed `pineagent-app` EC2 role. It does not
create roles, users, access keys, hosts, tables, or a second owner for Terraform
resources. The application uses its instance role, never root credentials.

Run `npm ci`, `npm test`, and `npm run synth` here for offline validation.
Set `CDK_OUTDIR=cdk.out` to retain the template for an inspected CloudFormation
change set. This asset-free stack uses a bootstrapless synthesizer: no CDK
bootstrap bucket, role, or SSM version parameter is needed.
The CloudFormation template permits only invocation/streaming of the US Opus 4.6
inference profile and its three foundation-model targets, with a profile condition
on the targets. No model listing, policy administration, or wildcard model access.

Before deployment the owner must explicitly approve deployment and confirm the
account, existing role, and gateway region (default `us-east-2`, matching existing
Terraform). Prefer a least-privilege operator. The owner explicitly authorized
the existing root operator session for this deployment only; no root credential
enters the application. Inspect the change set; it must contain only these three
policies. CloudFormation/CDK deployment and
bootstrap permissions are deliberately not part of the runtime policy.

Then verify role assumption on the actual host and perform one authorized,
bounded Bedrock request; successful synthesis does not establish model access,
quota, marketplace entitlement, SCP permission, or successful inference.
Rollback removes only these policies through their owning CloudFormation stack.
The confirmed router secrets are OPENAI_API_KEY and JEV_API_KEY in us-east-1;
the backend/model gateway remains in us-east-2. Secret contents are never packaged.

References: [CDK IAM policy](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_iam.CfnPolicy.html),
[Bedrock cross-region profiles](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-prereq.html).
