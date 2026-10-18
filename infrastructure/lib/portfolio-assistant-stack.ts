import { join } from "node:path";
import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";

export const ASSISTANT_STACK_NAME = "PortfolioAssistantStack";
/** Beside the site, so the distribution can use the function URL as an ordinary reference. */
export const ASSISTANT_REGION = "us-east-1";
/** Just above the app's 31-second stream deadline (ADR-009). */
export const ASK_TIMEOUT_SECONDS = 35;
export const ASK_MEMORY_MB = 256;
export const ASK_LOG_RETENTION = logs.RetentionDays.TWO_WEEKS;
export const DEFAULT_ANTHROPIC_MODEL_ID = "claude-haiku-4-5-20251001";
/** The secret the owner creates by hand. Override with -c anthropicSecretName=… */
export const DEFAULT_ANTHROPIC_SECRET_NAME = "career-portfolio/anthropic-api-key";
/** The adapter's handler script at the asset root (services/ask-api/lambda/run.sh). */
export const ASK_HANDLER = "run.sh";
export const READINESS_PATH = "/ready";
export const ADAPTER_PORT = "8080";

export const DEFAULT_LAMBDA_ASSET = join(import.meta.dirname, "..", "asset", "ask-api");
export const DEFAULT_WEB_ADAPTER_LAYER = join(
  import.meta.dirname,
  "..",
  "asset",
  "web-adapter-layer",
);

const SECRET_NAME = /^[A-Za-z0-9/_+=.@-]{1,256}$/;
const MODEL_ID = /^claude-[a-z]+(?:-[0-9]+){1,2}(?:-[0-9]{8})?$/;

export interface PortfolioAssistantStackProps extends cdk.StackProps {
  /** Name (not ARN) of the Secrets Manager secret holding the Anthropic API key. */
  secretName?: string;
  modelId?: string;
  lambdaAssetPath?: string;
  webAdapterLayerPath?: string;
}

/**
 * The production ask function: Python 3.13 on ARM64 running ask_api.production_app behind the
 * Lambda Web Adapter, exposed only through an IAM-authenticated function URL in
 * RESPONSE_STREAM mode. CloudFront (PortfolioSiteStack) is the only caller, through OAC.
 * No reserved concurrency: the account limit is the cap (ADR-009).
 */
export class PortfolioAssistantStack extends cdk.Stack {
  readonly askFunction: lambda.Function;
  readonly functionUrl: lambda.FunctionUrl;

  constructor(scope: Construct, id: string, props: PortfolioAssistantStackProps = {}) {
    super(scope, id, props);
    const secretName = props.secretName ?? DEFAULT_ANTHROPIC_SECRET_NAME;
    const modelId = props.modelId ?? DEFAULT_ANTHROPIC_MODEL_ID;
    if (!SECRET_NAME.test(secretName) || secretName.startsWith("arn:")) {
      throw new Error("anthropicSecretName must be a Secrets Manager secret name, not an ARN.");
    }
    if (!MODEL_ID.test(modelId)) {
      throw new Error("anthropicModelId must be a Claude model id.");
    }

    const logGroup = new logs.LogGroup(this, "AskLogs", {
      retention: ASK_LOG_RETENTION,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Our own layer from the pinned, checksummed adapter binary (pnpm prepare:web-adapter).
    const webAdapter = new lambda.LayerVersion(this, "WebAdapterLayer", {
      code: lambda.Code.fromAsset(props.webAdapterLayerPath ?? DEFAULT_WEB_ADAPTER_LAYER),
      compatibleArchitectures: [lambda.Architecture.ARM_64],
      description: "AWS Lambda Web Adapter (pinned binary, built by this project)",
      license: "Apache-2.0",
    });

    // Referenced by name only: the owner creates it, and the stack never reads or prints it.
    const secret = secretsmanager.Secret.fromSecretNameV2(this, "AnthropicKey", secretName);

    this.askFunction = new lambda.Function(this, "AskFunction", {
      runtime: lambda.Runtime.PYTHON_3_13,
      architecture: lambda.Architecture.ARM_64,
      handler: ASK_HANDLER,
      code: lambda.Code.fromAsset(props.lambdaAssetPath ?? DEFAULT_LAMBDA_ASSET),
      layers: [webAdapter],
      memorySize: ASK_MEMORY_MB,
      timeout: cdk.Duration.seconds(ASK_TIMEOUT_SECONDS),
      logGroup,
      description: "lucaselia.dev career assistant: streams answers for POST /api/ask",
      environment: {
        AWS_LAMBDA_EXEC_WRAPPER: "/opt/bootstrap",
        AWS_LWA_INVOKE_MODE: "response_stream",
        AWS_LWA_PORT: ADAPTER_PORT,
        AWS_LWA_READINESS_CHECK_PATH: READINESS_PATH,
        ASK_PROVIDER: "anthropic",
        ANTHROPIC_SECRET_NAME: secretName,
        ANTHROPIC_MODEL_ID: modelId,
      },
    });
    secret.grantRead(this.askFunction);

    this.functionUrl = this.askFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
    });

    new cdk.CfnOutput(this, "AskFunctionName", {
      value: this.askFunction.functionName,
      description: "For the kill switch: aws lambda put-function-concurrency",
    });

    cdk.Tags.of(this).add("Project", "career-portfolio");
    cdk.Tags.of(this).add("ManagedBy", "aws-cdk");
    cdk.Tags.of(this).add("Component", "assistant");
  }
}
