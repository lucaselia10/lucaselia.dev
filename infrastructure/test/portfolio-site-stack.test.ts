import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import {
  ASSET_CACHE_CONTROL,
  PAGE_CACHE_CONTROL,
  PortfolioSiteStack,
  SITE_REGION,
  VIEWER_REQUEST_SOURCE,
} from "../lib/portfolio-site-stack";
import { CONTENT_SECURITY_POLICY, PERMISSIONS_POLICY } from "../lib/site-headers";

const ZONE_ID = "Z0123456789TESTZONE";
const CACHING_OPTIMIZED = "658327ea-f89d-4fab-a63d-7e88639e58f6";

function siteDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "site-build-"));
  mkdirSync(join(directory, "_astro"));
  writeFileSync(join(directory, "index.html"), "<!doctype html><title>Site</title>");
  writeFileSync(join(directory, "_astro", "index.abc123.css"), "body{}");
  return directory;
}

function synth(): { stack: Stack; template: Template } {
  const app = new App();
  const stack = new PortfolioSiteStack(app, "PortfolioSiteStack", {
    hostedZoneId: ZONE_ID,
    siteDirectory: siteDirectory(),
    env: { account: "123456789012", region: SITE_REGION },
  });
  return { stack, template: Template.fromStack(stack) };
}

const { stack, template } = synth();

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
    template.resourceCountIs("AWS::CloudFront::OriginAccessControl", 1);
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
        ],
        Origins: [
          Match.objectLike({
            OriginAccessControlId: Match.anyValue(),
            S3OriginConfig: { OriginAccessIdentity: "" },
          }),
        ],
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

  it("attaches the viewer-request function to both behaviors", () => {
    template.resourceCountIs("AWS::CloudFront::Function", 1);
    template.hasResourceProperties("AWS::CloudFront::Function", {
      FunctionCode: readFileSync(VIEWER_REQUEST_SOURCE, "utf8"),
      FunctionConfig: Match.objectLike({ Runtime: "cloudfront-js-2.0" }),
    });
    const config = (
      Object.values(template.findResources("AWS::CloudFront::Distribution"))[0]?.Properties as {
        DistributionConfig: {
          DefaultCacheBehavior: { FunctionAssociations: unknown[] };
          CacheBehaviors: Array<{ FunctionAssociations: unknown[] }>;
        };
      }
    ).DistributionConfig;
    const functionId = Object.keys(template.findResources("AWS::CloudFront::Function"))[0];
    for (const behavior of [config.DefaultCacheBehavior, ...config.CacheBehaviors]) {
      expect(behavior.FunctionAssociations).toEqual([
        { EventType: "viewer-request", FunctionARN: { "Fn::GetAtt": [functionId, "FunctionARN"] } },
      ]);
    }
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
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("default-src 'none'");
    const config = (
      Object.values(template.findResources("AWS::CloudFront::Distribution"))[0]?.Properties as {
        DistributionConfig: {
          DefaultCacheBehavior: { ResponseHeadersPolicyId: unknown };
          CacheBehaviors: Array<{ ResponseHeadersPolicyId: unknown }>;
        };
      }
    ).DistributionConfig;
    expect(config.DefaultCacheBehavior.ResponseHeadersPolicyId).toBeDefined();
    expect(config.CacheBehaviors[0]?.ResponseHeadersPolicyId).toEqual(
      config.DefaultCacheBehavior.ResponseHeadersPolicyId,
    );
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

  it("contains none of the ask API resources and is tagged like the ask stack", () => {
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
    expect(
      () =>
        new PortfolioSiteStack(new App(), "Bad", {
          hostedZoneId: "not-a-zone",
          siteDirectory: siteDirectory(),
        }),
    ).toThrow(/hosted zone id/);
  });
});
