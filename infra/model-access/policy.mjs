import { Stack, BootstraplessSynthesizer, CfnParameter, CfnCondition, Fn, aws_iam as iam } from "aws-cdk-lib";

// Additive policy only: Terraform continues to own the host and its IAM role.
export class ModelAccessStack extends Stack {
  constructor(scope, id, props = {}) {
    super(scope, id, { ...props, synthesizer: new BootstraplessSynthesizer() });
    const role = new CfnParameter(this, "ApplicationRoleName", {
      type: "String", default: "pineagent-app", allowedPattern: "[A-Za-z0-9+=,.@_-]{1,64}",
      description: "Existing non-root EC2 application role managed by Terraform",
    });
    const region = new CfnParameter(this, "GatewayRegion", {
      type: "String", default: "us-east-2", allowedValues: ["us-east-1", "us-east-2", "us-west-2"],
      description: "Gateway invocation region; confirm before deployment",
    });
    const profile = this.formatArn({ service: "bedrock", region: region.valueAsString,
      resource: "inference-profile", resourceName: "us.anthropic.claude-opus-4-6-v1" });
    const actions = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"];
    new iam.CfnPolicy(this, "Opus46Access", {
      policyName: "pineagent-opus-46-only", roles: [role.valueAsString],
      policyDocument: {
        Version: "2012-10-17",
        Statement: [
          { Effect: "Allow", Action: actions, Resource: profile },
          { Effect: "Allow", Action: actions,
            Resource: ["us-east-1", "us-east-2", "us-west-2"].map((target) =>
              this.formatArn({ service: "bedrock", region: target, account: "", resource: "foundation-model",
                resourceName: "anthropic.claude-opus-4-6-v1" })),
            Condition: { StringEquals: { "bedrock:InferenceProfileArn": profile } },
          },
        ],
      },
    });
    // Exact, operator-supplied secret ARNs. No listing, writes, or wildcard access.
    for (const name of ["Decisions", "Jev"]) {
      const secret = new CfnParameter(this, `${name}SecretArn`, { type: "String", default: "",
        allowedPattern: "^$|^arn:aws:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$" });
      const configured = new CfnCondition(this, `${name}SecretConfigured`, {
        expression: Fn.conditionNot(Fn.conditionEquals(secret.valueAsString, "")),
      });
      const policy = new iam.CfnPolicy(this, `${name}SecretRead`, { policyName: `pineagent-${name.toLowerCase()}-read`, roles: [role.valueAsString],
        policyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: secret.valueAsString }] } });
      policy.cfnOptions.condition = configured;
    }
  }
}
