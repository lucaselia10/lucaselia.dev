import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import {
  ASK_HANDLER,
  CareerPortfolioStack,
  DEFAULT_ASK_ALLOWED_ORIGINS,
} from "../lib/career-portfolio-stack";

const assetDirectory = join(import.meta.dirname, "..", "asset", "ask-api");
const openApiPath = join(import.meta.dirname, "..", "..", "schemas", "ask-api.openapi.yaml");
const canonicalIndexPath = join(import.meta.dirname, "..", "..", "generated", "career-index.json");

describe("CareerPortfolioStack", () => {
  it("stages the ask package and the synchronized public index", () => {
    const staged = walk(assetDirectory);
    expect(staged).toContain("handler.py");
    expect(staged).toContain("data/__init__.py");
    expect(staged).toContain("data/career-index.json");
    expect(readFileSync(join(assetDirectory, "data", "career-index.json"))).toEqual(
      readFileSync(canonicalIndexPath),
    );
    const joined = staged.join("\n");
    expect(staged).toContain("bedrock_retriever.py");
    expect(staged).toContain("bedrock_generator.py");
    expect(staged).toContain("grounding_factory.py");
    expect(staged).toContain("boto3/__init__.py");
    expect(staged).toContain("botocore/__init__.py");
    const segments = staged.flatMap((path) => path.split("/"));
    for (const prohibited of [
      "__pycache__",
      ".venv",
      ".pytest_cache",
      ".ruff_cache",
      ".mypy_cache",
      "tests",
      "private-notes",
      "dist",
      "site-packages",
    ]) {
      expect(segments).not.toContain(prohibited);
    }
    expect(
      staged.some(
        (path) =>
          path.endsWith(".pyc") ||
          path.endsWith(".env") ||
          path.endsWith("credentials.json") ||
          path.endsWith("dev_server.py") ||
          path.includes("retrieval/"),
      ),
    ).toBe(false);
    // No test runner is shipped. (anyio's optional pytest_plugin.py module is part of anyio.)
    expect(
      staged
        .map((path) => path.split("/")[0] ?? "")
        .filter((top) => /^_?pytest([-_.]|$)/.test(top)),
    ).toEqual([]);
    expect(joined).not.toContain("pyright");
    expect(joined).not.toContain("boto3_stubs");
    expect(joined).not.toContain("retrieval_publisher");
    expect(segments.some((segment) => segment.startsWith("ruff"))).toBe(false);
  });

  it("synthesizes the public HTTP API and one Python Lambda", () => {
    const template = synthesize();
    const resources = template.toJSON().Resources as Record<
      string,
      { Type: string; Properties?: Record<string, unknown> }
    >;
    const types = Object.values(resources).map((resource) => resource.Type);

    expect(types.filter((type) => type === "AWS::Lambda::Function")).toEqual([
      "AWS::Lambda::Function",
    ]);
    expect(types.filter((type) => type === "AWS::ApiGatewayV2::Api")).toHaveLength(1);
    expect(types.filter((type) => type === "AWS::ApiGatewayV2::Integration")).toHaveLength(1);
    expect(types.filter((type) => type === "AWS::ApiGatewayV2::Route")).toHaveLength(1);
    expect(types.filter((type) => type === "AWS::ApiGatewayV2::Stage")).toHaveLength(1);
    expect(types.filter((type) => type === "AWS::Logs::LogGroup")).toHaveLength(2);
    expect(types).not.toContain("AWS::ApiGateway::RestApi");
    expect(types).not.toContain("AWS::Lambda::Url");
    expect(types).not.toContain("AWS::DynamoDB::Table");
    expect(types).not.toContain("AWS::SQS::Queue");
    expect(types).not.toContain("AWS::SNS::Topic");
    expect(types).not.toContain("AWS::OpenSearchService::Domain");
    expect(types).not.toContain("AWS::SecretsManager::Secret");
    expect(types).not.toContain("AWS::KMS::Key");
    expect(types.some((type) => type.startsWith("AWS::EC2::"))).toBe(false);
    expect(types.some((type) => type.includes("CustomResource"))).toBe(false);

    template.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "python3.13",
      Architectures: ["arm64"],
      MemorySize: 256,
      Timeout: 28,
      ReservedConcurrentExecutions: 5,
      Handler: ASK_HANDLER,
    });
    const functions = template.findResources("AWS::Lambda::Function");
    const askFunction = Object.values(functions)[0] as {
      Properties: { LoggingConfig: { LogGroup: { Ref: string } } };
    };
    expect(askFunction.Properties.LoggingConfig.LogGroup.Ref).toMatch(/^AskFunctionLogGroup/);
    const taggedFunction = Object.values(functions)[0] as {
      Properties: { Tags: Array<{ Key: string; Value: string }> };
    };
    expect(taggedFunction.Properties.Tags).toEqual(
      expect.arrayContaining([
        { Key: "Project", Value: "career-portfolio" },
        { Key: "ManagedBy", Value: "aws-cdk" },
      ]),
    );

    template.hasResourceProperties("AWS::ApiGatewayV2::Api", {
      ProtocolType: "HTTP",
      CorsConfiguration: {
        AllowOrigins: [...DEFAULT_ASK_ALLOWED_ORIGINS],
        AllowMethods: ["POST", "OPTIONS"],
        AllowHeaders: ["Content-Type"],
        AllowCredentials: false,
      },
    });
    template.hasResourceProperties("AWS::ApiGatewayV2::Integration", {
      TimeoutInMillis: 29_000,
      PayloadFormatVersion: "2.0",
    });
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "POST /ask",
    });
    template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      AutoDeploy: true,
      StageName: "$default",
      DefaultRouteSettings: {
        ThrottlingRateLimit: 5,
        ThrottlingBurstLimit: 10,
      },
    });
    template.hasResourceProperties("AWS::Logs::LogGroup", {
      LogGroupName: "/career-portfolio/ask-function",
      RetentionInDays: 30,
    });
    template.hasResourceProperties("AWS::Logs::LogGroup", {
      LogGroupName: "/career-portfolio/ask-access",
      RetentionInDays: 30,
    });
    for (const logGroup of Object.values(template.findResources("AWS::Logs::LogGroup"))) {
      expect(logGroup).toMatchObject({ DeletionPolicy: "Delete", UpdateReplacePolicy: "Delete" });
    }

    const stage = Object.values(resources).find(
      (resource) => resource.Type === "AWS::ApiGatewayV2::Stage",
    );
    const accessLogSettings = stage?.Properties?.AccessLogSettings as { Format: string };
    const format = accessLogSettings.Format;
    expect(format).toContain("$context.requestId");
    expect(format).toContain("$context.routeKey");
    expect(format).toContain("$context.status");
    expect(format).toContain("$context.integrationStatus");
    expect(format).toContain("$context.integrationErrorMessage");
    expect(format).toContain("$context.responseLength");
    expect(format).toContain("$context.responseLatency");
    expect(format.toLowerCase()).not.toContain("sourceip");
    expect(format.toLowerCase()).not.toContain("useragent");

    const outputs = template.toJSON().Outputs as Record<string, { Description?: string }>;
    expect(Object.keys(outputs).sort()).toEqual([
      "AskApiBaseUrl",
      "AskApiUrl",
      "AskFunctionName",
      "DataSourceId",
      "KnowledgeBaseId",
      "KnowledgeBaseSourceBucketName",
      "NovaModelId",
      "VectorIndexArn",
    ]);
    expect(outputs.AskApiUrl?.Description).toContain("POST /ask");
    expect(JSON.stringify(template.toJSON())).not.toContain("RetrieveAndGenerate");
    expect(JSON.stringify(template.toJSON())).not.toContain("dynamodb:");
    expect(JSON.stringify(template.toJSON())).not.toContain("sqs:");
    expect(JSON.stringify(template.toJSON())).not.toContain("sns:");
  });

  it("matches the OpenAPI POST /ask operation", () => {
    const template = synthesize();
    const openApi = readFileSync(openApiPath, "utf8");
    expect(openApiHasPostAsk(openApi)).toBe(true);
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "POST /ask",
    });
  });

  it("reads production origins from CDK context and rejects a wildcard", () => {
    const configured = Template.fromStack(
      new CareerPortfolioStack(
        new App({ context: { askAllowedOrigins: "https://portfolio.example" } }),
        "Configured",
      ),
    );
    configured.hasResourceProperties("AWS::ApiGatewayV2::Api", {
      CorsConfiguration: {
        AllowOrigins: ["https://portfolio.example"],
      },
    });

    expect(
      () => new CareerPortfolioStack(new App({ context: { askAllowedOrigins: "*" } }), "Wildcard"),
    ).toThrow(/wildcard/);
  });

  it("rejects a region other than us-west-2 and an invalid Nova profile", () => {
    expect(
      () =>
        new CareerPortfolioStack(new App(), "WrongRegion", {
          env: { region: "us-east-1" },
        }),
    ).toThrow(/us-west-2/);
    expect(
      () =>
        new CareerPortfolioStack(
          new App({ context: { novaInferenceProfileId: "anthropic.claude-v1:0" } }),
          "WrongModel",
        ),
    ).toThrow(/nova-2-lite/);
  });

  it("bounds grounding resources and the two IAM roles", () => {
    const template = synthesize();
    const resources = template.toJSON().Resources as Record<string, CfnResource>;
    const ofType = (type: string) =>
      Object.entries(resources).filter(([, resource]) => resource.Type === type);

    expect(ofType("AWS::S3::Bucket")).toHaveLength(1);
    expect(ofType("AWS::S3Vectors::VectorBucket")).toHaveLength(1);
    expect(ofType("AWS::S3Vectors::Index")).toHaveLength(1);
    expect(ofType("AWS::Bedrock::KnowledgeBase")).toHaveLength(1);
    expect(ofType("AWS::Bedrock::DataSource")).toHaveLength(1);
    expect(ofType("AWS::IAM::Role")).toHaveLength(2);
    expect(ofType("AWS::Lambda::Function")).toHaveLength(1);

    const bucket = ofType("AWS::S3::Bucket")[0]?.[1];
    expect(bucket?.DeletionPolicy).toBe("Retain");
    expect(bucket?.UpdateReplacePolicy).toBe("Retain");
    expect(bucket?.Properties).toMatchObject({
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      VersioningConfiguration: { Status: "Enabled" },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
        ],
      },
    });
    expect(JSON.stringify(bucket?.Properties?.LifecycleConfiguration)).toContain(
      '"NoncurrentDays":90',
    );
    expect(bucket?.Properties?.BucketName).toBeUndefined();
    expect(bucket?.Properties?.WebsiteConfiguration).toBeUndefined();
    expect(bucket?.Properties?.CorsConfiguration).toBeUndefined();
    expect(bucket?.Properties?.NotificationConfiguration).toBeUndefined();

    const vectorBucket = ofType("AWS::S3Vectors::VectorBucket")[0]?.[1];
    expect(vectorBucket?.DeletionPolicy).toBe("Retain");
    expect(vectorBucket?.Properties?.EncryptionConfiguration).toEqual({ SseType: "AES256" });
    expect(vectorBucket?.Properties?.VectorBucketName).toBeUndefined();

    const vectorIndex = ofType("AWS::S3Vectors::Index")[0];
    expect(vectorIndex?.[1].DeletionPolicy).toBe("Retain");
    expect(vectorIndex?.[1].Properties).toMatchObject({
      DataType: "float32",
      Dimension: 512,
      DistanceMetric: "cosine",
      EncryptionConfiguration: { SseType: "AES256" },
    });
    expect(vectorIndex?.[1].Properties?.IndexName).toBeUndefined();
    expect(normalizeDependsOn(vectorIndex?.[1].DependsOn)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^RetrievalVectorBucket/)]),
    );

    const knowledgeBase = ofType("AWS::Bedrock::KnowledgeBase")[0];
    const knowledgeBaseJson = JSON.stringify(knowledgeBase?.[1].Properties);
    expect(knowledgeBaseJson).toContain('"Type":"VECTOR"');
    expect(knowledgeBaseJson).toContain('"Type":"S3_VECTORS"');
    expect(knowledgeBaseJson).toContain('"Dimensions":512');
    expect(knowledgeBaseJson).toContain('"EmbeddingDataType":"FLOAT32"');
    expect(knowledgeBaseJson).toContain("amazon.titan-embed-text-v2:0");
    expect(knowledgeBaseJson).not.toContain("nova");
    expect(normalizeDependsOn(knowledgeBase?.[1].DependsOn)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^RetrievalVectorIndex/),
        expect.stringMatching(/^KnowledgeBaseRole/),
        expect.stringMatching(/^KnowledgeBaseRoleDefaultPolicy/),
      ]),
    );

    const dataSource = ofType("AWS::Bedrock::DataSource")[0]?.[1];
    expect(dataSource?.Properties?.DataSourceConfiguration).toMatchObject({
      Type: "S3",
      S3Configuration: { InclusionPrefixes: ["retrieval/"] },
    });
    expect(dataSource?.Properties?.VectorIngestionConfiguration).toEqual({
      ChunkingConfiguration: { ChunkingStrategy: "NONE" },
    });
    expect(normalizeDependsOn(dataSource?.DependsOn)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^CareerKnowledgeBase/)]),
    );

    const knowledgeBaseRole = roleForService(resources, "bedrock.amazonaws.com");
    const askRole = roleForService(resources, "lambda.amazonaws.com");
    expect(knowledgeBaseRole.logicalId).not.toBe(askRole.logicalId);
    const trust = JSON.stringify(knowledgeBaseRole.resource.Properties?.AssumeRolePolicyDocument);
    expect(trust).toContain("aws:SourceAccount");
    expect(trust).toContain("aws:SourceArn");
    expect(trust).toContain("knowledge-base/*");
    expect(trust).toContain("us-west-2");

    const knowledgeBaseStatements = statementsForRole(resources, knowledgeBaseRole.logicalId);
    expect(actionSet(knowledgeBaseStatements)).toEqual(
      new Set([
        "bedrock:InvokeModel",
        "s3:GetObject",
        "s3:ListBucket",
        "s3vectors:DeleteVectors",
        "s3vectors:GetIndex",
        "s3vectors:GetVectors",
        "s3vectors:PutVectors",
        "s3vectors:QueryVectors",
      ]),
    );
    const titanStatement = knowledgeBaseStatements.find((statement) =>
      actionsOf(statement).includes("bedrock:InvokeModel"),
    );
    expect(JSON.stringify(titanStatement?.Resource)).toContain(
      "foundation-model/amazon.titan-embed-text-v2:0",
    );
    expect(JSON.stringify(titanStatement?.Resource)).not.toContain("nova");
    const listStatement = knowledgeBaseStatements.find((statement) =>
      actionsOf(statement).includes("s3:ListBucket"),
    );
    expect(JSON.stringify(listStatement?.Condition)).toContain("retrieval/");
    expect(JSON.stringify(listStatement?.Condition)).toContain("retrieval/*");
    const readStatement = knowledgeBaseStatements.find((statement) =>
      actionsOf(statement).includes("s3:GetObject"),
    );
    expect(JSON.stringify(readStatement?.Resource)).toContain("retrieval/*");
    expect(JSON.stringify(readStatement)).not.toContain("s3:PutObject");
    const vectorStatement = knowledgeBaseStatements.find((statement) =>
      actionsOf(statement).includes("s3vectors:QueryVectors"),
    );
    expect(JSON.stringify(vectorStatement?.Resource)).not.toBe('"*"');

    const askStatements = statementsForRole(resources, askRole.logicalId);
    expect(actionSet(askStatements)).toEqual(
      new Set([
        "bedrock:InvokeModel",
        "bedrock:Retrieve",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
      ]),
    );
    expect(JSON.stringify(askStatements)).not.toContain("s3:");
    expect(JSON.stringify(askStatements)).not.toContain("s3vectors:");
    expect(JSON.stringify(askStatements)).not.toContain("titan-embed");
    const retrieveStatement = askStatements.find((statement) =>
      actionsOf(statement).includes("bedrock:Retrieve"),
    );
    expect(JSON.stringify(retrieveStatement?.Resource)).toContain("KnowledgeBaseArn");
    const invokeStatements = askStatements.filter((statement) =>
      actionsOf(statement).includes("bedrock:InvokeModel"),
    );
    expect(invokeStatements).toHaveLength(2);
    const profileArn = {
      "Fn::Join": [
        "",
        [
          "arn:",
          { Ref: "AWS::Partition" },
          ":bedrock:us-west-2:",
          { Ref: "AWS::AccountId" },
          ":inference-profile/us.amazon.nova-2-lite-v1:0",
        ],
      ],
    };
    const profileStatement = invokeStatements.find((statement) =>
      JSON.stringify(statement.Resource).includes("inference-profile"),
    );
    const foundationStatement = invokeStatements.find((statement) =>
      JSON.stringify(statement.Resource).includes("foundation-model/amazon.nova-2-lite-v1:0"),
    );
    expect(profileStatement).not.toBe(foundationStatement);
    expect(profileStatement).toMatchObject({
      Action: "bedrock:InvokeModel",
      Effect: "Allow",
      Resource: profileArn,
    });
    expect(profileStatement?.Condition).toBeUndefined();
    expect(foundationStatement).toMatchObject({
      Action: "bedrock:InvokeModel",
      Effect: "Allow",
      Resource: {
        "Fn::Join": [
          "",
          [
            "arn:",
            { Ref: "AWS::Partition" },
            ":bedrock:*::foundation-model/amazon.nova-2-lite-v1:0",
          ],
        ],
      },
      Condition: {
        StringEquals: {
          "bedrock:InferenceProfileArn": profileArn,
        },
      },
    });

    const applicationStatements = [...knowledgeBaseStatements, ...askStatements];
    for (const statement of applicationStatements) {
      expect(actionsOf(statement)).not.toContain("bedrock:*");
      expect(actionsOf(statement)).not.toContain("bedrock:RetrieveAndGenerate");
      expect(actionsOf(statement)).not.toContain("bedrock:InvokeModelWithResponseStream");
      expect(unrestrictedResource(statement.Resource)).toBe(false);
    }
    expect(iamActions(template.toJSON())).not.toContain("bedrock:*");
    expect(iamActions(template.toJSON())).not.toContain("bedrock:RetrieveAndGenerate");
  });
});

interface CfnResource {
  Type: string;
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
  DependsOn?: string | string[];
  Properties?: Record<string, unknown>;
}

function normalizeDependsOn(dependsOn: string | string[] | undefined): string[] {
  if (dependsOn === undefined) {
    return [];
  }
  return Array.isArray(dependsOn) ? dependsOn : [dependsOn];
}

interface PolicyStatement {
  Action?: string | string[];
  Effect?: string;
  Resource?: unknown;
  Condition?: unknown;
}

function synthesize(): Template {
  return Template.fromStack(new CareerPortfolioStack(new App(), "TestStack"));
}

function openApiHasPostAsk(source: string): boolean {
  const lines = source.split("\n");
  let inAsk = false;
  for (const line of lines) {
    if (line === "  /ask:") {
      inAsk = true;
      continue;
    }
    if (inAsk && line.startsWith("  ") && !line.startsWith("    ")) {
      return false;
    }
    if (inAsk && line === "    post:") {
      return true;
    }
  }
  return false;
}

function roleForService(
  resources: Record<string, CfnResource>,
  service: string,
): { logicalId: string; resource: CfnResource } {
  const found = Object.entries(resources).find(
    ([, resource]) =>
      resource.Type === "AWS::IAM::Role" &&
      JSON.stringify(resource.Properties?.AssumeRolePolicyDocument).includes(service),
  );
  if (!found) {
    throw new Error(`Missing role for ${service}`);
  }
  return { logicalId: found[0], resource: found[1] };
}

function statementsForRole(
  resources: Record<string, CfnResource>,
  roleLogicalId: string,
): PolicyStatement[] {
  const statements: PolicyStatement[] = [];
  for (const resource of Object.values(resources)) {
    if (resource.Type !== "AWS::IAM::Policy") {
      continue;
    }
    const roles = resource.Properties?.Roles;
    const attached = Array.isArray(roles)
      ? roles.some(
          (role) =>
            typeof role === "object" &&
            role !== null &&
            "Ref" in role &&
            (role as { Ref?: string }).Ref === roleLogicalId,
        )
      : false;
    if (!attached) {
      continue;
    }
    const document = resource.Properties?.PolicyDocument as { Statement?: PolicyStatement[] };
    statements.push(...(document.Statement ?? []));
  }
  return statements;
}

function actionsOf(statement: PolicyStatement): string[] {
  if (Array.isArray(statement.Action)) {
    return statement.Action;
  }
  return typeof statement.Action === "string" ? [statement.Action] : [];
}

function actionSet(statements: readonly PolicyStatement[]): Set<string> {
  return new Set(statements.flatMap((statement) => actionsOf(statement)));
}

function unrestrictedResource(resource: unknown): boolean {
  if (resource === "*") {
    return true;
  }
  return Array.isArray(resource) && resource.some((item) => item === "*");
}

function iamActions(template: { Resources?: Record<string, unknown> }): string[] {
  const actions = new Set<string>();
  for (const resource of Object.values(template.Resources ?? {})) {
    collectActions(resource, actions);
  }
  return [...actions].sort();
}

function collectActions(value: unknown, actions: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectActions(item, actions);
    }
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.Action)) {
    for (const action of record.Action) {
      if (typeof action === "string") {
        actions.add(action);
      }
    }
  } else if (typeof record.Action === "string") {
    actions.add(record.Action);
  }
  for (const nested of Object.values(record)) {
    collectActions(nested, actions);
  }
}

function walk(directory: string): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    const relativePath = relative(assetDirectory, fullPath);
    if (entry.isDirectory()) {
      paths.push(relativePath, ...walk(fullPath));
      continue;
    }
    if (statSync(fullPath).isFile()) {
      paths.push(relativePath);
    }
  }
  return paths;
}
