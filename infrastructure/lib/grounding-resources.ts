import * as cdk from "aws-cdk-lib";
import * as bedrock from "aws-cdk-lib/aws-bedrock";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3vectors from "aws-cdk-lib/aws-s3vectors";
import type { Construct } from "constructs";

export const APPLICATION_REGION = "us-west-2";
export const TITAN_EMBEDDING_MODEL_ID = "amazon.titan-embed-text-v2:0";
export const DEFAULT_NOVA_INFERENCE_PROFILE_ID = "us.amazon.nova-2-lite-v1:0";
export const EMBEDDING_DIMENSIONS = 512;
export const RETRIEVAL_RESULT_LIMIT = 5;
export const RETRIEVAL_PREFIX = "retrieval/";
export const LAMBDA_TIMEOUT_SECONDS = 28;
export const API_INTEGRATION_TIMEOUT_SECONDS = 29;
/**
 * Noncurrent object versions in the source bucket expire after 90 days.
 * Current retrieval artifacts stay until a later sync replaces them.
 */
export const NONCURRENT_VERSION_EXPIRATION_DAYS = 90;

const NOVA_INFERENCE_PROFILE_PATTERN = /^us\.amazon\.nova-2-lite-v[0-9]+:[0-9]+$/;

export interface GroundingResources {
  readonly sourceBucket: s3.Bucket;
  readonly knowledgeBase: bedrock.CfnKnowledgeBase;
  readonly dataSource: bedrock.CfnDataSource;
  readonly vectorIndex: s3vectors.CfnIndex;
  readonly novaInferenceProfileId: string;
}

export function assertTargetRegion(region: string | undefined): void {
  if (region !== undefined && region !== "" && region !== APPLICATION_REGION) {
    throw new Error(
      `The career portfolio stack must use ${APPLICATION_REGION}. Received ${region}.`,
    );
  }
}

export function resolveNovaInferenceProfileId(scope: Construct): string {
  const configured: unknown = scope.node.tryGetContext("novaInferenceProfileId");
  if (configured === undefined) {
    return DEFAULT_NOVA_INFERENCE_PROFILE_ID;
  }
  if (typeof configured !== "string" || !NOVA_INFERENCE_PROFILE_PATTERN.test(configured)) {
    throw new Error("novaInferenceProfileId must be a us.amazon.nova-2-lite inference profile ID.");
  }
  return configured;
}

export function novaFoundationModelId(inferenceProfileId: string): string {
  if (!NOVA_INFERENCE_PROFILE_PATTERN.test(inferenceProfileId)) {
    throw new Error("novaInferenceProfileId must be a us.amazon.nova-2-lite inference profile ID.");
  }
  return inferenceProfileId.slice("us.".length);
}

export function addGroundingResources(
  stack: cdk.Stack,
  askFunctionRole: iam.Role,
): GroundingResources {
  const novaInferenceProfileId = resolveNovaInferenceProfileId(stack);
  const foundationModelId = novaFoundationModelId(novaInferenceProfileId);
  const sourceBucket = new s3.Bucket(stack, "KnowledgeBaseSourceBucket", {
    encryption: s3.BucketEncryption.S3_MANAGED,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    enforceSSL: true,
    versioned: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    lifecycleRules: [
      {
        id: "ExpireNoncurrentRetrievalVersions",
        enabled: true,
        noncurrentVersionExpiration: cdk.Duration.days(NONCURRENT_VERSION_EXPIRATION_DAYS),
      },
    ],
  });

  const vectorBucket = new s3vectors.CfnVectorBucket(stack, "RetrievalVectorBucket", {
    encryptionConfiguration: { sseType: "AES256" },
  });
  vectorBucket.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

  const vectorIndex = new s3vectors.CfnIndex(stack, "RetrievalVectorIndex", {
    vectorBucketArn: vectorBucket.attrVectorBucketArn,
    dataType: "float32",
    dimension: EMBEDDING_DIMENSIONS,
    distanceMetric: "cosine",
    encryptionConfiguration: { sseType: "AES256" },
  });
  vectorIndex.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
  vectorIndex.node.addDependency(vectorBucket);

  const knowledgeBaseRole = new iam.Role(stack, "KnowledgeBaseRole", {
    assumedBy: new iam.ServicePrincipal("bedrock.amazonaws.com", {
      conditions: {
        StringEquals: {
          "aws:SourceAccount": stack.account,
        },
        ArnLike: {
          "aws:SourceArn": stack.formatArn({
            service: "bedrock",
            region: APPLICATION_REGION,
            resource: "knowledge-base",
            resourceName: "*",
            arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
          }),
        },
      },
    }),
    description: "Embeds retrieval documents and writes the S3 vector index.",
  });
  knowledgeBaseRole.addToPolicy(
    new iam.PolicyStatement({
      sid: "EmbedWithTitan",
      actions: ["bedrock:InvokeModel"],
      resources: [foundationModelArn(stack, APPLICATION_REGION, "", TITAN_EMBEDDING_MODEL_ID)],
    }),
  );
  knowledgeBaseRole.addToPolicy(
    new iam.PolicyStatement({
      sid: "ListRetrievalPrefix",
      actions: ["s3:ListBucket"],
      resources: [sourceBucket.bucketArn],
      conditions: {
        StringLike: {
          "s3:prefix": [RETRIEVAL_PREFIX, `${RETRIEVAL_PREFIX}*`],
        },
      },
    }),
  );
  knowledgeBaseRole.addToPolicy(
    new iam.PolicyStatement({
      sid: "ReadRetrievalObjects",
      actions: ["s3:GetObject"],
      resources: [sourceBucket.arnForObjects(`${RETRIEVAL_PREFIX}*`)],
    }),
  );
  knowledgeBaseRole.addToPolicy(
    new iam.PolicyStatement({
      sid: "WriteVectorIndex",
      actions: [
        "s3vectors:PutVectors",
        "s3vectors:GetVectors",
        "s3vectors:DeleteVectors",
        "s3vectors:QueryVectors",
        "s3vectors:GetIndex",
      ],
      resources: [vectorIndex.attrIndexArn],
    }),
  );

  const knowledgeBase = new bedrock.CfnKnowledgeBase(stack, "CareerKnowledgeBase", {
    name: "career-portfolio",
    description: "Approved public career sections for retrieve-then-generate answers.",
    roleArn: knowledgeBaseRole.roleArn,
    knowledgeBaseConfiguration: {
      type: "VECTOR",
      vectorKnowledgeBaseConfiguration: {
        embeddingModelArn: foundationModelArn(
          stack,
          APPLICATION_REGION,
          "",
          TITAN_EMBEDDING_MODEL_ID,
        ),
        embeddingModelConfiguration: {
          bedrockEmbeddingModelConfiguration: {
            dimensions: EMBEDDING_DIMENSIONS,
            embeddingDataType: "FLOAT32",
          },
        },
      },
    },
    storageConfiguration: {
      type: "S3_VECTORS",
      s3VectorsConfiguration: {
        indexArn: vectorIndex.attrIndexArn,
        vectorBucketArn: vectorBucket.attrVectorBucketArn,
      },
    },
  });
  knowledgeBase.node.addDependency(vectorIndex);
  knowledgeBase.node.addDependency(knowledgeBaseRole);
  knowledgeBase.node.addDependency(knowledgeBaseRole.node.findChild("DefaultPolicy"));

  const dataSource = new bedrock.CfnDataSource(stack, "CareerKnowledgeBaseDataSource", {
    name: "career-portfolio-retrieval",
    description: "Pre-chunked public citation sections under retrieval/.",
    knowledgeBaseId: knowledgeBase.attrKnowledgeBaseId,
    dataSourceConfiguration: {
      type: "S3",
      s3Configuration: {
        bucketArn: sourceBucket.bucketArn,
        inclusionPrefixes: [RETRIEVAL_PREFIX],
      },
    },
    vectorIngestionConfiguration: {
      chunkingConfiguration: {
        chunkingStrategy: "NONE",
      },
    },
  });
  dataSource.node.addDependency(knowledgeBase);

  const inferenceProfileArn = stack.formatArn({
    service: "bedrock",
    region: APPLICATION_REGION,
    resource: "inference-profile",
    resourceName: novaInferenceProfileId,
    arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
  });
  askFunctionRole.addToPolicy(
    new iam.PolicyStatement({
      sid: "RetrieveCareerKnowledgeBase",
      actions: ["bedrock:Retrieve"],
      resources: [knowledgeBase.attrKnowledgeBaseArn],
    }),
  );
  askFunctionRole.addToPolicy(
    new iam.PolicyStatement({
      sid: "InvokeNovaProfile",
      actions: ["bedrock:InvokeModel"],
      resources: [inferenceProfileArn],
    }),
  );
  askFunctionRole.addToPolicy(
    new iam.PolicyStatement({
      sid: "InvokeNovaFoundationModel",
      actions: ["bedrock:InvokeModel"],
      resources: [foundationModelArn(stack, "*", "", foundationModelId)],
      conditions: {
        StringEquals: {
          "bedrock:InferenceProfileArn": inferenceProfileArn,
        },
      },
    }),
  );

  return {
    sourceBucket,
    knowledgeBase,
    dataSource,
    vectorIndex,
    novaInferenceProfileId,
  };
}

function foundationModelArn(
  stack: cdk.Stack,
  region: string,
  account: string,
  modelId: string,
): string {
  return cdk.Arn.format(
    {
      service: "bedrock",
      region,
      account,
      resource: "foundation-model",
      resourceName: modelId,
      arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
    },
    stack,
  );
}
