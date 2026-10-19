import { App } from "aws-cdk-lib";
import { Match } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ANTHROPIC_MODEL_ID,
  DEFAULT_ANTHROPIC_SECRET_NAME,
  PortfolioAssistantStack,
} from "../lib/portfolio-assistant-stack";
import { TEST_ENV, preparedAssets, synthesizeStacks } from "./fixtures";

const { assistant, assistantTemplate: template } = synthesizeStacks();

function functionProperties(): Record<string, unknown> {
  const functions = Object.values(template.findResources("AWS::Lambda::Function")).filter(
    (resource) => (resource.Properties as { Handler?: string }).Handler === "run.sh",
  );
  expect(functions).toHaveLength(1);
  return functions[0]?.Properties as Record<string, unknown>;
}

describe("PortfolioAssistantStack", () => {
  it("lives in us-east-1 beside the site", () => {
    expect(assistant.region).toBe("us-east-1");
  });

  it("runs the production app on Python 3.13 arm64 behind the Web Adapter", () => {
    const properties = functionProperties();
    expect(properties).toMatchObject({
      Runtime: "python3.13",
      Architectures: ["arm64"],
      Handler: "run.sh",
      MemorySize: 512,
      Timeout: 35,
    });
    expect((properties.Environment as { Variables: Record<string, string> }).Variables).toEqual({
      AWS_LAMBDA_EXEC_WRAPPER: "/opt/bootstrap",
      AWS_LWA_INVOKE_MODE: "response_stream",
      AWS_LWA_PORT: "8080",
      AWS_LWA_READINESS_CHECK_PATH: "/ready",
      ASK_PROVIDER: "anthropic",
      ANTHROPIC_SECRET_NAME: DEFAULT_ANTHROPIC_SECRET_NAME,
      ANTHROPIC_MODEL_ID: DEFAULT_ANTHROPIC_MODEL_ID,
    });
    expect(properties.ReservedConcurrentExecutions).toBeUndefined();
  });

  it("uses its own adapter layer, never a layer ARN from another account", () => {
    template.resourceCountIs("AWS::Lambda::LayerVersion", 1);
    template.hasResourceProperties("AWS::Lambda::LayerVersion", {
      CompatibleArchitectures: ["arm64"],
      Content: { S3Bucket: Match.anyValue(), S3Key: Match.anyValue() },
    });
    const layerId = Object.keys(template.findResources("AWS::Lambda::LayerVersion"))[0];
    expect(functionProperties().Layers).toEqual([{ Ref: layerId }]);
    expect(JSON.stringify(template.toJSON())).not.toMatch(/arn:aws:lambda:[^"]*:layer:/);
  });

  it("serves a streaming function URL that requires IAM (CloudFront OAC)", () => {
    template.resourceCountIs("AWS::Lambda::Url", 1);
    template.hasResourceProperties("AWS::Lambda::Url", {
      AuthType: "AWS_IAM",
      InvokeMode: "RESPONSE_STREAM",
    });
    // No public invoke permission: the only grants are the site stack's, for its distribution.
    template.resourceCountIs("AWS::Lambda::Permission", 0);
  });

  it("can read only the named secret, which it references and never creates", () => {
    template.resourceCountIs("AWS::SecretsManager::Secret", 0);
    const statements = Object.values(template.findResources("AWS::IAM::Policy")).flatMap(
      (policy) =>
        (policy.Properties as { PolicyDocument: { Statement: Array<Record<string, unknown>> } })
          .PolicyDocument.Statement,
    );
    const secretStatements = statements.filter((statement) =>
      JSON.stringify(statement.Action).includes("secretsmanager"),
    );
    expect(secretStatements).toHaveLength(1);
    const statement = secretStatements[0] as { Action: string[]; Resource: unknown };
    expect(statement.Action.sort()).toEqual([
      "secretsmanager:DescribeSecret",
      "secretsmanager:GetSecretValue",
    ]);
    const resource = JSON.stringify(statement.Resource);
    expect(resource).toContain(`:secret:${DEFAULT_ANTHROPIC_SECRET_NAME}-??????`);
    expect(resource).not.toContain("*");
  });

  it("keeps logs for 14 days", () => {
    template.hasResourceProperties("AWS::Logs::LogGroup", { RetentionInDays: 14 });
    const logGroupId = Object.keys(template.findResources("AWS::Logs::LogGroup"))[0];
    expect(functionProperties().LoggingConfig).toEqual({ LogGroup: { Ref: logGroupId } });
  });

  it("accepts a different secret name from context, and refuses an ARN or a bad model id", () => {
    const { assistantTemplate } = synthesizeStacks("other/anthropic-key");
    expect(JSON.stringify(assistantTemplate.toJSON())).toContain("other/anthropic-key");
    expect(
      () =>
        new PortfolioAssistantStack(new App(), "Arn", {
          ...preparedAssets(),
          secretName: "arn:aws:secretsmanager:us-east-1:123456789012:secret:x",
          env: TEST_ENV,
        }),
    ).toThrow(/not an ARN/);
    expect(
      () =>
        new PortfolioAssistantStack(new App(), "Model", {
          ...preparedAssets(),
          modelId: "gpt-4",
          env: TEST_ENV,
        }),
    ).toThrow(/Claude model id/);
  });
});
