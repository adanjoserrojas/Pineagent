import { App } from "aws-cdk-lib";
import { ModelAccessStack } from "./policy.mjs";

// Offline synthesis only: no lookups, credentials, deployment or bootstrap.
const app = new App();
new ModelAccessStack(app, "PineagentModelAccess");
app.synth();
