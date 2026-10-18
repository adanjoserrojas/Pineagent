import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { ModelAccessStack } from "./policy.mjs";

test("adds only a scoped policy to the existing application role, never credentials or infrastructure", () => {
  const template = Template.fromStack(new ModelAccessStack(new App(), "Test")).toJSON();
  const resources = Object.values(template.Resources);
  assert.equal(template.Parameters.BootstrapVersion, undefined);
  assert.equal(template.Rules, undefined);
  assert.equal(resources.length, 3);
  const policy = template.Resources.Opus46Access;
  assert.equal(policy.Type, "AWS::IAM::Policy");
  assert.deepEqual(policy.Properties.Roles, [{ Ref: "ApplicationRoleName" }]);
  const statements = policy.Properties.PolicyDocument.Statement;
  assert.equal(statements.length, 2);
  for (const s of statements) {
    assert.deepEqual(s.Action, ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]);
    assert.equal(s.Effect, "Allow");
    assert.ok(!JSON.stringify(s).includes("*"));
  }
  assert.equal(statements[1].Resource.length, 3);
  assert.deepEqual(statements[1].Condition.StringEquals["bedrock:InferenceProfileArn"], statements[0].Resource);
  for (const region of ["us-east-1", "us-east-2", "us-west-2"]) {
    assert.ok(JSON.stringify(statements[1].Resource).includes(`${region}::foundation-model/anthropic.claude-opus-4-6-v1`));
  }
  assert.ok(JSON.stringify(statements[0].Resource).includes("inference-profile/us.anthropic.claude-opus-4-6-v1"));
});

test("secret access is conditional and restricted to the exact supplied ARNs", () => {
  const template = Template.fromStack(new ModelAccessStack(new App(), "Test")).toJSON();
  for (const name of ["Decisions", "Jev"]) {
    const resource = template.Resources[`${name}SecretRead`];
    assert.equal(resource.Type, "AWS::IAM::Policy");
    assert.equal(resource.Condition, `${name}SecretConfigured`);
    assert.deepEqual(resource.Properties.PolicyDocument.Statement, [{ Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: { Ref: `${name}SecretArn` } }]);
  }
});
