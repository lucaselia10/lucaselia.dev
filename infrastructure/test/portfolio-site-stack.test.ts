import { readFileSync } from "node:fs";
import { App } from "aws-cdk-lib";
import { Match } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { PortfolioAssistantStack } from "../lib/portfolio-assistant-stack";
import {
  API_RATE_LIMITED_BODY,
  ASSET_CACHE_CONTROL,
  PAGE_CACHE_CONTROL,
  PortfolioSiteStack,
  VIEWER_REQUEST_SOURCE,
} from "../lib/portfolio-site-stack";
import {
  CONTENT_SECURITY_POLICY,
  INLINE_SCRIPT_HASHES,
  PERMISSIONS_POLICY,
} from "../lib/site-headers";
import { TEST_ENV, ZONE_ID, preparedAssets, siteDirectory, synthesizeStacks } from "./fixtures";

const CACHING_OPTIMIZED = "658327ea-f89d-4fab-a63d-7e88639e58f6";
const CACHING_DISABLED = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad";

const { site: stack, siteTemplate: template } = synthesizeStacks();

interface Behavior {
  PathPattern?: string;
  TargetOriginId: string;
  FunctionAssociations?: unknown[];
  ResponseHeadersPolicyId?: unknown;
  [key: string]: unknown;
}

function distributionConfig(): {
  DefaultCacheBehavior: Behavior;
  CacheBehaviors: Behavior[];
  Origins: Array<Record<string, unknown>>;
  WebACLId: unknown;
} {
  return (
    Object.values(template.findResources("AWS::CloudFront::Distribution"))[0]?.Properties as {
      DistributionConfig: ReturnType<typeof distributionConfig>;
    }
  ).DistributionConfig;
}

describe("PortfolioSiteStack", () => {
  it("lives in us-east-1, where CloudFront certificates must be", () => {
    expect(stack.region).toBe("us-east-1");
  });

  it("keeps the bucket private, encrypted, SSL-only, and readable only through OAC", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
        ],
      },
    });
    template.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Deny",
            Condition: { Bool: { "aws:SecureTransport": "false" } },
          }),
          Match.objectLike({
            Effect: "Allow",
            Principal: { Service: "cloudfront.amazonaws.com" },
            Action: "s3:GetObject",
            Condition: { StringEquals: { "AWS:SourceArn": Match.anyValue() } },
          }),
        ]),
      },
    });
    // Two OACs: this one for S3, and the Lambda one for /api/* (tested below).
    template.resourceCountIs("AWS::CloudFront::OriginAccessControl", 2);
    template.hasResourceProperties("AWS::CloudFront::OriginAccessControl", {
      OriginAccessControlConfig: Match.objectLike({
        OriginAccessControlOriginType: "s3",
        SigningBehavior: "always",
        SigningProtocol: "sigv4",
      }),
    });
    template.resourceCountIs("AWS::CloudFront::CloudFrontOriginAccessIdentity", 0);
  });

  it("serves both hostnames over HTTPS with HTTP/2 and HTTP/3", () => {
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        Aliases: ["lucaselia.dev", "www.lucaselia.dev"],
        DefaultRootObject: "index.html",
        HttpVersion: "http2and3",
        IPV6Enabled: true,
        PriceClass: "PriceClass_100",
        ViewerCertificate: Match.objectLike({
          SslSupportMethod: "sni-only",
          MinimumProtocolVersion: "TLSv1.2_2021",
        }),
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: "redirect-to-https",
          Compress: true,
          AllowedMethods: ["GET", "HEAD"],
        }),
        CacheBehaviors: [
          Match.objectLike({
            PathPattern: "/_astro/*",
            ViewerProtocolPolicy: "redirect-to-https",
            Compress: true,
            CachePolicyId: CACHING_OPTIMIZED,
          }),
          Match.objectLike({ PathPattern: "/api/*" }),
        ],
        Origins: Match.arrayWith([
          Match.objectLike({
            OriginAccessControlId: Match.anyValue(),
            S3OriginConfig: { OriginAccessIdentity: "" },
          }),
        ]),
      }),
    });
    const distribution = Object.values(template.findResources("AWS::CloudFront::Distribution"))[0];
    expect(JSON.stringify(distribution)).not.toContain("Logging");
  });

  it("validates one certificate for the apex and www through DNS in the hosted zone", () => {
    template.resourceCountIs("AWS::CertificateManager::Certificate", 1);
    template.hasResourceProperties("AWS::CertificateManager::Certificate", {
      DomainName: "lucaselia.dev",
      SubjectAlternativeNames: ["www.lucaselia.dev"],
      ValidationMethod: "DNS",
      DomainValidationOptions: Match.arrayWith([
        { DomainName: "lucaselia.dev", HostedZoneId: ZONE_ID },
        { DomainName: "www.lucaselia.dev", HostedZoneId: ZONE_ID },
      ]),
    });
  });

  it("points A and AAAA aliases for the apex and www at the distribution", () => {
    const records = Object.values(template.findResources("AWS::Route53::RecordSet")).map(
      (resource) => resource.Properties as { Name: string; Type: string; HostedZoneId: string },
    );
    expect(records.map((record) => `${record.Type} ${record.Name}`).sort()).toEqual([
      "A lucaselia.dev.",
      "A www.lucaselia.dev.",
      "AAAA lucaselia.dev.",
      "AAAA www.lucaselia.dev.",
    ]);
    for (const record of records) {
      expect(record.HostedZoneId).toBe(ZONE_ID);
    }
    template.hasResourceProperties("AWS::Route53::RecordSet", {
      AliasTarget: { DNSName: { "Fn::GetAtt": [Match.anyValue(), "DomainName"] } },
    });
  });

  it("attaches the viewer-request function to the page behaviors only, not /api/*", () => {
    template.resourceCountIs("AWS::CloudFront::Function", 1);
    template.hasResourceProperties("AWS::CloudFront::Function", {
      FunctionCode: readFileSync(VIEWER_REQUEST_SOURCE, "utf8"),
      FunctionConfig: Match.objectLike({ Runtime: "cloudfront-js-2.0" }),
    });
    const config = distributionConfig();
    const functionId = Object.keys(template.findResources("AWS::CloudFront::Function"))[0];
    const pages = config.CacheBehaviors.filter((behavior) => behavior.PathPattern !== "/api/*");
    for (const behavior of [config.DefaultCacheBehavior, ...pages]) {
      expect(behavior.FunctionAssociations).toEqual([
        { EventType: "viewer-request", FunctionARN: { "Fn::GetAtt": [functionId, "FunctionARN"] } },
      ]);
    }
    const api = config.CacheBehaviors.find((behavior) => behavior.PathPattern === "/api/*");
    expect(api?.FunctionAssociations).toBeUndefined();
  });

  it("sends the security headers on every response", () => {
    template.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: {
          StrictTransportSecurity: {
            AccessControlMaxAgeSec: 63072000,
            IncludeSubdomains: true,
            Override: true,
          },
          ContentTypeOptions: { Override: true },
          ReferrerPolicy: { ReferrerPolicy: "strict-origin-when-cross-origin", Override: true },
          FrameOptions: { FrameOption: "DENY", Override: true },
          ContentSecurityPolicy: { ContentSecurityPolicy: CONTENT_SECURITY_POLICY, Override: true },
        },
        CustomHeadersConfig: {
          Items: [{ Header: "Permissions-Policy", Value: PERMISSIONS_POLICY, Override: true }],
        },
      }),
    });
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain(
      `script-src 'self' ${INLINE_SCRIPT_HASHES.map((hash) => `'${hash}'`).join(" ")};`,
    );
    expect(CONTENT_SECURITY_POLICY).toContain("connect-src 'self'");
    expect(CONTENT_SECURITY_POLICY).not.toContain("'unsafe-eval'");
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(CONTENT_SECURITY_POLICY).toContain("default-src 'none'");
    const config = distributionConfig();
    expect(config.DefaultCacheBehavior.ResponseHeadersPolicyId).toBeDefined();
    for (const behavior of config.CacheBehaviors) {
      expect(behavior.ResponseHeadersPolicyId).toEqual(
        config.DefaultCacheBehavior.ResponseHeadersPolicyId,
      );
    }
  });

  it("returns /404.html with status 404 for missing objects", () => {
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        CustomErrorResponses: [
          {
            ErrorCode: 403,
            ResponseCode: 404,
            ResponsePagePath: "/404.html",
            ErrorCachingMinTTL: 300,
          },
          {
            ErrorCode: 404,
            ResponseCode: 404,
            ResponsePagePath: "/404.html",
            ErrorCachingMinTTL: 300,
          },
        ],
      }),
    });
  });

  it("caches hashed assets for a year and pages briefly, and invalidates on deploy", () => {
    template.hasResourceProperties("AWS::CloudFront::CachePolicy", {
      CachePolicyConfig: Match.objectLike({ MinTTL: 0, DefaultTTL: 300, MaxTTL: 3600 }),
    });
    template.resourceCountIs("Custom::CDKBucketDeployment", 2);
    template.hasResourceProperties("Custom::CDKBucketDeployment", {
      Exclude: ["*"],
      Include: ["_astro/*"],
      Prune: false,
      SystemMetadata: { "cache-control": ASSET_CACHE_CONTROL },
    });
    template.hasResourceProperties("Custom::CDKBucketDeployment", {
      Exclude: ["_astro/*"],
      Prune: true,
      SystemMetadata: { "cache-control": PAGE_CACHE_CONTROL },
      DistributionPaths: ["/*"],
    });
    expect(ASSET_CACHE_CONTROL).toBe("public, max-age=31536000, immutable");
  });

  it("contains none of the retired ask API resources and is tagged as the site", () => {
    for (const type of [
      "AWS::ApiGatewayV2::Api",
      "AWS::Bedrock::KnowledgeBase",
      "AWS::Bedrock::DataSource",
      "AWS::S3Vectors::VectorBucket",
      "AWS::S3Vectors::Index",
    ]) {
      template.resourceCountIs(type, 0);
    }
    template.resourceCountIs("AWS::S3::Bucket", 1);
    for (const tag of [
      { Key: "Project", Value: "career-portfolio" },
      { Key: "ManagedBy", Value: "aws-cdk" },
      { Key: "Component", Value: "site" },
    ]) {
      template.hasResourceProperties("AWS::S3::Bucket", { Tags: Match.arrayWith([tag]) });
    }
  });

  it("rejects a malformed hosted zone id", () => {
    const app = new App();
    const assistant = new PortfolioAssistantStack(app, "Assistant", {
      ...preparedAssets(),
      env: TEST_ENV,
    });
    expect(
      () =>
        new PortfolioSiteStack(app, "Bad", {
          hostedZoneId: "not-a-zone",
          siteDirectory: siteDirectory(),
          askFunctionUrl: assistant.functionUrl,
          env: TEST_ENV,
        }),
    ).toThrow(/hosted zone id/);
  });
});

describe("PortfolioSiteStack /api/*", () => {
  const api = (): Behavior => {
    const found = distributionConfig().CacheBehaviors.find(
      (behavior) => behavior.PathPattern === "/api/*",
    );
    expect(found).toBeDefined();
    return found as Behavior;
  };

  it("sends /api/* to the function URL origin: no cache, all methods, HTTPS only", () => {
    expect(api()).toMatchObject({
      ViewerProtocolPolicy: "https-only",
      AllowedMethods: ["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "POST", "DELETE"],
      CachePolicyId: CACHING_DISABLED,
      Compress: false,
    });
    const origin = distributionConfig().Origins.find((item) => item.Id === api().TargetOriginId);
    expect(origin?.ConnectionAttempts).toBe(1);
    expect((origin?.CustomOriginConfig as { OriginReadTimeout: number }).OriginReadTimeout).toBe(
      40,
    );
    expect(origin?.OriginAccessControlId).toBeDefined();
    expect(JSON.stringify(origin?.DomainName)).toContain("FunctionUrl");
  });

  it("uses a Lambda OAC that always signs with SigV4", () => {
    template.resourceCountIs("AWS::CloudFront::OriginAccessControl", 2);
    template.hasResourceProperties("AWS::CloudFront::OriginAccessControl", {
      OriginAccessControlConfig: Match.objectLike({
        OriginAccessControlOriginType: "lambda",
        SigningBehavior: "always",
        SigningProtocol: "sigv4",
      }),
    });
  });

  it("forwards only Content-Type, Accept, and the body hash: no cookies or query strings", () => {
    template.resourceCountIs("AWS::CloudFront::OriginRequestPolicy", 1);
    template.hasResourceProperties("AWS::CloudFront::OriginRequestPolicy", {
      OriginRequestPolicyConfig: Match.objectLike({
        HeadersConfig: {
          HeaderBehavior: "whitelist",
          Headers: ["Content-Type", "Accept", "x-amz-content-sha256"],
        },
        CookiesConfig: { CookieBehavior: "none" },
        QueryStringsConfig: { QueryStringBehavior: "none" },
      }),
    });
    const policyId = Object.keys(template.findResources("AWS::CloudFront::OriginRequestPolicy"))[0];
    expect(api().OriginRequestPolicyId).toEqual({ Ref: policyId });
  });

  it("lets CloudFront invoke the function only on behalf of this distribution", () => {
    const permissions = Object.values(template.findResources("AWS::Lambda::Permission")).map(
      (resource) => resource.Properties as Record<string, unknown>,
    );
    expect(permissions.map((permission) => permission.Action).sort()).toEqual([
      "lambda:InvokeFunction",
      "lambda:InvokeFunctionUrl",
    ]);
    const distributionId = Object.keys(template.findResources("AWS::CloudFront::Distribution"))[0];
    for (const permission of permissions) {
      expect(permission.Principal).toBe("cloudfront.amazonaws.com");
      const sourceArn = JSON.stringify(permission.SourceArn);
      expect(sourceArn).toContain(":cloudfront::");
      expect(sourceArn).toContain(":distribution/");
      expect(sourceArn).toContain(`"Ref":"${distributionId}"`);
      expect(JSON.stringify(permission.FunctionName)).toContain("Fn::ImportValue");
    }
  });

  it("rate-limits /api/ per IP: 20 in 10 minutes, blocked with a JSON 429", () => {
    template.resourceCountIs("AWS::WAFv2::WebACL", 1);
    template.hasResourceProperties("AWS::WAFv2::WebACL", {
      Scope: "CLOUDFRONT",
      DefaultAction: { Allow: {} },
      CustomResponseBodies: {
        "rate-limited": { ContentType: "APPLICATION_JSON", Content: API_RATE_LIMITED_BODY },
      },
      Rules: [
        {
          Name: "api-rate-limit",
          Priority: 0,
          Action: {
            Block: { CustomResponse: { ResponseCode: 429, CustomResponseBodyKey: "rate-limited" } },
          },
          Statement: {
            RateBasedStatement: {
              Limit: 20,
              EvaluationWindowSec: 600,
              AggregateKeyType: "IP",
              ScopeDownStatement: {
                ByteMatchStatement: {
                  FieldToMatch: { UriPath: {} },
                  PositionalConstraint: "STARTS_WITH",
                  SearchString: "/api/",
                  TextTransformations: [{ Priority: 0, Type: "NONE" }],
                },
              },
            },
          },
          VisibilityConfig: Match.objectLike({ SampledRequestsEnabled: false }),
        },
      ],
    });
    expect(JSON.parse(API_RATE_LIMITED_BODY)).toEqual({
      message: "Too many questions in a short time. Please wait a few minutes.",
      code: "rate_limited",
    });
    const aclId = Object.keys(template.findResources("AWS::WAFv2::WebACL"))[0];
    expect(distributionConfig().WebACLId).toEqual({ "Fn::GetAtt": [aclId, "Arn"] });
    expect(JSON.stringify(template.toJSON())).not.toContain("ManagedRuleGroupStatement");
  });

  it("leaves the page behaviors exactly as they were", () => {
    const config = distributionConfig();
    expect(config.DefaultCacheBehavior).toMatchObject({
      ViewerProtocolPolicy: "redirect-to-https",
      AllowedMethods: ["GET", "HEAD"],
      Compress: true,
    });
    expect(config.DefaultCacheBehavior.OriginRequestPolicyId).toBeUndefined();
    const assets = config.CacheBehaviors.find((behavior) => behavior.PathPattern === "/_astro/*");
    expect(assets).toMatchObject({
      AllowedMethods: ["GET", "HEAD"],
      CachePolicyId: CACHING_OPTIMIZED,
      Compress: true,
    });
    expect(assets?.OriginRequestPolicyId).toBeUndefined();
    expect(config.DefaultCacheBehavior.TargetOriginId).toEqual(assets?.TargetOriginId);
    expect(api().TargetOriginId).not.toEqual(assets?.TargetOriginId);
  });
});
