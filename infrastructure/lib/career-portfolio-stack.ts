import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as cdk from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";
import {
  API_INTEGRATION_TIMEOUT_SECONDS,
  APPLICATION_REGION,
  LAMBDA_TIMEOUT_SECONDS,
  RETRIEVAL_RESULT_LIMIT,
  addGroundingResources,
  assertTargetRegion,
} from "./grounding-resources";

const assetDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "asset", "ask-api");

export const DEFAULT_ASK_ALLOWED_ORIGINS = [
  "http://localhost:4321",
  "http://127.0.0.1:4321",
] as const;

export const ASK_THROTTLE_RATE_PER_SECOND = 5;
export const ASK_THROTTLE_BURST = 10;
export const ASK_HANDLER = "ask_api.handler.handler";

/**
 * Removal policy for log groups in this undeployed portfolio stack.
 * DESTROY lets a future stack deletion remove the groups. Retention still
 * expires events after 30 days while the stack exists. Change this to RETAIN
 * before the first production deployment if logs must outlive the stack.
 */
const LOG_REMOVAL_POLICY = cdk.RemovalPolicy.DESTROY;

export interface CareerPortfolioStackProps extends cdk.StackProps {
  readonly allowedOrigins?: readonly string[];
  readonly lambdaAssetPath?: string;
}

export class CareerPortfolioStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: CareerPortfolioStackProps) {
    assertTargetRegion(props?.env?.region);
    super(scope, id, {
      ...props,
      env: {
        account: props?.env?.account,
        region: APPLICATION_REGION,
      },
      description:
        props?.description ??
        "Public HTTP API for POST /ask. Synthesized only; this stack is not deployed.",
    });

    cdk.Tags.of(this).add("Project", "career-portfolio");
    cdk.Tags.of(this).add("ManagedBy", "aws-cdk");

    const allowedOrigins = resolveAllowedOrigins(this, props?.allowedOrigins);
    const lambdaAssetPath = props?.lambdaAssetPath ?? assetDirectory;

    const functionLogGroup = new logs.LogGroup(this, "AskFunctionLogGroup", {
      logGroupName: "/career-portfolio/ask-function",
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: LOG_REMOVAL_POLICY,
    });
    const accessLogGroup = new logs.LogGroup(this, "AskAccessLogGroup", {
      logGroupName: "/career-portfolio/ask-access",
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: LOG_REMOVAL_POLICY,
    });

    const role = new iam.Role(this, "AskFunctionRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: "Executes the ask Lambda and writes its CloudWatch logs.",
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [functionLogGroup.logGroupArn, `${functionLogGroup.logGroupArn}:*`],
      }),
    );

    const grounding = addGroundingResources(this, role);

    const askFunction = new lambda.Function(this, "AskFunction", {
      runtime: lambda.Runtime.PYTHON_3_13,
      architecture: lambda.Architecture.ARM_64,
      handler: ASK_HANDLER,
      code: lambda.Code.fromAsset(lambdaAssetPath),
      memorySize: 256,
      timeout: cdk.Duration.seconds(LAMBDA_TIMEOUT_SECONDS),
      reservedConcurrentExecutions: 5,
      role,
      logGroup: functionLogGroup,
      description: "Answers POST /ask from the bundled public career index.",
      environment: {
        GROUNDING_ENABLED: "true",
        KNOWLEDGE_BASE_ID: grounding.knowledgeBase.attrKnowledgeBaseId,
        NOVA_MODEL_ID: grounding.novaInferenceProfileId,
        GROUNDING_RETRIEVAL_LIMIT: String(RETRIEVAL_RESULT_LIMIT),
      },
    });

    const httpApi = new apigwv2.HttpApi(this, "AskHttpApi", {
      apiName: "career-portfolio-ask",
      description: "Public V1 ask API. CORS is not authentication.",
      createDefaultStage: false,
      corsPreflight: {
        allowOrigins: [...allowedOrigins],
        allowMethods: [apigwv2.CorsHttpMethod.POST, apigwv2.CorsHttpMethod.OPTIONS],
        allowHeaders: ["Content-Type"],
        allowCredentials: false,
      },
    });

    const integration = new HttpLambdaIntegration("AskIntegration", askFunction, {
      payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0,
      timeout: cdk.Duration.seconds(API_INTEGRATION_TIMEOUT_SECONDS),
    });
    httpApi.addRoutes({
      path: "/ask",
      methods: [apigwv2.HttpMethod.POST],
      integration,
    });

    const stage = httpApi.addStage("AskStage", {
      stageName: "$default",
      autoDeploy: true,
      throttle: {
        rateLimit: ASK_THROTTLE_RATE_PER_SECOND,
        burstLimit: ASK_THROTTLE_BURST,
      },
      accessLogSettings: {
        destination: new apigwv2.LogGroupLogDestination(accessLogGroup),
        format: apigateway.AccessLogFormat.custom(
          JSON.stringify({
            requestId: apigateway.AccessLogField.contextRequestId(),
            extendedRequestId: apigateway.AccessLogField.contextExtendedRequestId(),
            routeKey: apigateway.AccessLogField.contextRouteKey(),
            status: apigateway.AccessLogField.contextStatus(),
            integrationStatus: apigateway.AccessLogField.contextIntegrationStatus(),
            integrationError: apigateway.AccessLogField.contextIntegrationErrorMessage(),
            responseLength: apigateway.AccessLogField.contextResponseLength(),
            integrationLatency: apigateway.AccessLogField.contextIntegrationLatency(),
            responseLatency: apigateway.AccessLogField.contextResponseLatency(),
          }),
        ),
      },
    });

    accessLogGroup.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal("apigateway.amazonaws.com")],
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [accessLogGroup.logGroupArn, `${accessLogGroup.logGroupArn}:*`],
        conditions: {
          ArnLike: {
            "aws:SourceArn": this.formatArn({
              service: "execute-api",
              resource: httpApi.apiId,
              arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
              resourceName: "*",
            }),
          },
        },
      }),
    );

    new cdk.CfnOutput(this, "AskApiBaseUrl", {
      value: stage.url,
      description: "HTTP API base URL. This output is not written into the web app.",
    });
    new cdk.CfnOutput(this, "AskApiUrl", {
      value: `${stage.url}ask`,
      description: "POST /ask URL. This output is not written into the web app.",
    });
    new cdk.CfnOutput(this, "AskFunctionName", {
      value: askFunction.functionName,
      description: "Ask Lambda function name.",
    });
    new cdk.CfnOutput(this, "KnowledgeBaseId", {
      value: grounding.knowledgeBase.attrKnowledgeBaseId,
      description: "Bedrock Knowledge Base ID. Content sync uses this later.",
    });
    new cdk.CfnOutput(this, "DataSourceId", {
      value: grounding.dataSource.attrDataSourceId,
      description: "Bedrock data source ID. CDK does not start ingestion.",
    });
    new cdk.CfnOutput(this, "KnowledgeBaseSourceBucketName", {
      value: grounding.sourceBucket.bucketName,
      description: "Private bucket for retrieval/ artifacts. Nothing is uploaded by this stack.",
    });
    new cdk.CfnOutput(this, "VectorIndexArn", {
      value: grounding.vectorIndex.attrIndexArn,
      description: "S3 Vectors index used by the Knowledge Base.",
    });
    new cdk.CfnOutput(this, "NovaModelId", {
      value: grounding.novaInferenceProfileId,
      description: "Nova inference profile ID passed to the ask Lambda.",
    });
  }
}

export function resolveAllowedOrigins(
  scope: Construct,
  override?: readonly string[],
): readonly string[] {
  if (override) {
    return validateOrigins(override);
  }
  const configured: unknown = scope.node.tryGetContext("askAllowedOrigins");
  if (configured === undefined) {
    return DEFAULT_ASK_ALLOWED_ORIGINS;
  }
  if (typeof configured !== "string") {
    throw new Error("askAllowedOrigins must be a comma-separated string.");
  }
  return validateOrigins(
    configured
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin !== ""),
  );
}

function validateOrigins(origins: readonly string[]): readonly string[] {
  if (origins.length === 0) {
    throw new Error("At least one ask API origin is required.");
  }
  if (origins.some((origin) => origin === "*" || origin.includes("*"))) {
    throw new Error("askAllowedOrigins cannot use a wildcard origin.");
  }
  return origins;
}
