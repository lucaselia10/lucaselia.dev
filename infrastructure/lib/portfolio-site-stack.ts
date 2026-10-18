import { join } from "node:path";
import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import type { Construct } from "constructs";
import { CONTENT_SECURITY_POLICY, HSTS_MAX_AGE_SECONDS, PERMISSIONS_POLICY } from "./site-headers";

export const SITE_DOMAIN = "lucaselia.dev";
export const SITE_WWW_DOMAIN = `www.${SITE_DOMAIN}`;
/** CloudFront only accepts certificates from us-east-1, so the whole site stack lives there. */
export const SITE_REGION = "us-east-1";
export const SITE_STACK_NAME = "PortfolioSiteStack";
export const VIEWER_REQUEST_SOURCE = join(import.meta.dirname, "site-viewer-request.js");
const HOSTED_ZONE_ID = /^Z[A-Z0-9]{1,32}$/;

/** Hashed Astro assets never change at a given URL. */
export const ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
/** Browsers revalidate HTML on every visit; CloudFront keeps it for five minutes between deploys. */
export const PAGE_CACHE_CONTROL = "public, max-age=0, s-maxage=300, must-revalidate";

/** The ask API path. CloudFront routes it to the function URL; everything else is the site. */
export const API_PATH_PATTERN = "/api/*";
/** Only what the app reads and what OAC signs. No cookies, no query strings. */
export const API_FORWARDED_HEADERS = ["Content-Type", "Accept", "x-amz-content-sha256"] as const;
/** Covers the first byte (cold start plus model) and every gap between streamed chunks. */
export const API_READ_TIMEOUT_SECONDS = 40;
/** WAF: per IP, 20 requests in a 10-minute window, on /api/ only (ADR-009). */
export const API_RATE_LIMIT = 20;
export const API_RATE_WINDOW_SECONDS = 600;
export const API_RATE_SCOPE = "/api/";
/** A 429 with a small JSON body; WAF's default 403 would become the site's 404 page. */
export const API_RATE_LIMITED_BODY = JSON.stringify({
  message: "Too many questions in a short time. Please wait a few minutes.",
  code: "rate_limited",
});

export interface PortfolioSiteStackProps extends cdk.StackProps {
  /** Route 53 hosted zone for lucaselia.dev, passed at deploy time and never stored in the repo. */
  hostedZoneId: string;
  /** The production build to upload (apps/web/dist after `pnpm build:site`). */
  siteDirectory: string;
  /** The ask function's URL (PortfolioAssistantStack), served at /api/* through OAC. */
  askFunctionUrl: lambda.IFunctionUrl;
}

/**
 * The portfolio: a private S3 bucket behind CloudFront with Origin Access Control, an ACM
 * certificate, Route 53 aliases, and security headers. /api/* goes to the ask function URL
 * (PortfolioAssistantStack) through OAC, behind a WAF rate limit (ADR-009).
 */
export class PortfolioSiteStack extends cdk.Stack {
  readonly bucket: s3.Bucket;
  readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: PortfolioSiteStackProps) {
    super(scope, id, props);
    if (!HOSTED_ZONE_ID.test(props.hostedZoneId)) {
      throw new Error("siteHostedZoneId must be a Route 53 hosted zone id such as Z0123456789ABC.");
    }

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
      hostedZoneId: props.hostedZoneId,
      zoneName: SITE_DOMAIN,
    });

    // Holds only build output, so it can be destroyed and rebuilt from Git at any time.
    this.bucket = new s3.Bucket(this, "SiteBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const certificate = new acm.Certificate(this, "SiteCertificate", {
      domainName: SITE_DOMAIN,
      subjectAlternativeNames: [SITE_WWW_DOMAIN],
      validation: acm.CertificateValidation.fromDns(zone),
    });

    const viewerRequest = new cloudfront.Function(this, "ViewerRequest", {
      code: cloudfront.FunctionCode.fromFile({ filePath: VIEWER_REQUEST_SOURCE }),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: "Redirect www to the apex and serve <path>/index.html",
    });

    const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, "SecurityHeaders", {
      comment: "lucaselia.dev security headers",
      securityHeadersBehavior: {
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.seconds(HSTS_MAX_AGE_SECONDS),
          includeSubdomains: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        contentSecurityPolicy: { contentSecurityPolicy: CONTENT_SECURITY_POLICY, override: true },
      },
      customHeadersBehavior: {
        customHeaders: [
          { header: "Permissions-Policy", value: PERMISSIONS_POLICY, override: true },
        ],
      },
    });

    // HTML and other unhashed files: honor the origin's short Cache-Control.
    const pageCache = new cloudfront.CachePolicy(this, "PageCache", {
      comment: "lucaselia.dev pages: short cache, revalidated",
      minTtl: cdk.Duration.seconds(0),
      defaultTtl: cdk.Duration.minutes(5),
      maxTtl: cdk.Duration.hours(1),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
    });

    const origin = origins.S3BucketOrigin.withOriginAccessControl(this.bucket);

    // The ask API: never cached, POST allowed, only the headers the app and OAC need, and no
    // viewer-request function (that one rewrites page paths).
    const apiRequests = new cloudfront.OriginRequestPolicy(this, "ApiRequests", {
      comment: "lucaselia.dev ask API: content type, accept, and the OAC body hash only",
      headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(...API_FORWARDED_HEADERS),
      cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
      queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.none(),
    });
    const apiOrigin = origins.FunctionUrlOrigin.withOriginAccessControl(props.askFunctionUrl, {
      readTimeout: cdk.Duration.seconds(API_READ_TIMEOUT_SECONDS),
      connectionAttempts: 1,
    });
    const webAcl = this.rateLimit();
    const functionAssociations = [
      { function: viewerRequest, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
    ];

    this.distribution = new cloudfront.Distribution(this, "SiteDistribution", {
      comment: "lucaselia.dev static portfolio",
      domainNames: [SITE_DOMAIN, SITE_WWW_DOMAIN],
      certificate,
      defaultRootObject: "index.html",
      webAclId: webAcl.attrArn,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      enableIpv6: true,
      defaultBehavior: {
        origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        compress: true,
        cachePolicy: pageCache,
        responseHeadersPolicy: securityHeaders,
        functionAssociations,
      },
      additionalBehaviors: {
        "/_astro/*": {
          origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          compress: true,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          responseHeadersPolicy: securityHeaders,
          functionAssociations,
        },
        [API_PATH_PATTERN]: {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          compress: false,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: apiRequests,
          responseHeadersPolicy: securityHeaders,
        },
      },
      // The bucket is private and OAC cannot list it, so a missing key comes back as 403.
      errorResponses: [403, 404].map((httpStatus) => ({
        httpStatus,
        responseHttpStatus: 404,
        responsePagePath: "/404.html",
        ttl: cdk.Duration.minutes(5),
      })),
    });

    // CDK's OAC origin grants lambda:InvokeFunctionUrl. CloudFront's OAC guide for function
    // URLs also requires lambda:InvokeFunction, scoped the same way to this distribution.
    new lambda.CfnPermission(this, "ApiInvokeFunctionFromDistribution", {
      action: "lambda:InvokeFunction",
      principal: "cloudfront.amazonaws.com",
      functionName: props.askFunctionUrl.functionArn,
      sourceArn: this.distributionArn(),
    });

    const aliasTarget = route53.RecordTarget.fromAlias(
      new targets.CloudFrontTarget(this.distribution),
    );
    new route53.ARecord(this, "ApexA", { zone, target: aliasTarget });
    new route53.AaaaRecord(this, "ApexAaaa", { zone, target: aliasTarget });
    new route53.ARecord(this, "WwwA", { zone, recordName: "www", target: aliasTarget });
    new route53.AaaaRecord(this, "WwwAaaa", { zone, recordName: "www", target: aliasTarget });

    // Hashed assets first, kept across deploys so cached pages never reference a missing file.
    const assets = new s3deploy.BucketDeployment(this, "DeployAssets", {
      sources: [s3deploy.Source.asset(props.siteDirectory)],
      destinationBucket: this.bucket,
      exclude: ["*"],
      include: ["_astro/*"],
      cacheControl: [s3deploy.CacheControl.fromString(ASSET_CACHE_CONTROL)],
      prune: false,
    });
    // Then pages and other files, pruning stale ones, and invalidating CloudFront.
    const pages = new s3deploy.BucketDeployment(this, "DeployPages", {
      sources: [s3deploy.Source.asset(props.siteDirectory)],
      destinationBucket: this.bucket,
      exclude: ["_astro/*"],
      cacheControl: [s3deploy.CacheControl.fromString(PAGE_CACHE_CONTROL)],
      prune: true,
      distribution: this.distribution,
      distributionPaths: ["/*"],
    });
    pages.node.addDependency(assets);

    new cdk.CfnOutput(this, "SiteUrl", { value: `https://${SITE_DOMAIN}` });
    new cdk.CfnOutput(this, "DistributionId", { value: this.distribution.distributionId });
    new cdk.CfnOutput(this, "DistributionDomainName", {
      value: this.distribution.distributionDomainName,
    });

    cdk.Tags.of(this).add("Project", "career-portfolio");
    cdk.Tags.of(this).add("ManagedBy", "aws-cdk");
    cdk.Tags.of(this).add("Component", "site");
  }

  private distributionArn(): string {
    return `arn:${cdk.Aws.PARTITION}:cloudfront::${cdk.Aws.ACCOUNT_ID}:distribution/${this.distribution.distributionId}`;
  }

  /** One rate-based rule; no managed rule groups. Sampled requests stay off (no request data). */
  private rateLimit(): wafv2.CfnWebACL {
    const visibility = (metricName: string) => ({
      cloudWatchMetricsEnabled: true,
      metricName,
      sampledRequestsEnabled: false,
    });
    return new wafv2.CfnWebACL(this, "SiteWebAcl", {
      scope: "CLOUDFRONT",
      description: "lucaselia.dev: per-IP rate limit on /api/",
      defaultAction: { allow: {} },
      visibilityConfig: visibility("SiteWebAcl"),
      customResponseBodies: {
        "rate-limited": { contentType: "APPLICATION_JSON", content: API_RATE_LIMITED_BODY },
      },
      rules: [
        {
          name: "api-rate-limit",
          priority: 0,
          action: {
            block: {
              customResponse: { responseCode: 429, customResponseBodyKey: "rate-limited" },
            },
          },
          statement: {
            rateBasedStatement: {
              limit: API_RATE_LIMIT,
              evaluationWindowSec: API_RATE_WINDOW_SECONDS,
              aggregateKeyType: "IP",
              scopeDownStatement: {
                byteMatchStatement: {
                  fieldToMatch: { uriPath: {} },
                  positionalConstraint: "STARTS_WITH",
                  searchString: API_RATE_SCOPE,
                  textTransformations: [{ priority: 0, type: "NONE" }],
                },
              },
            },
          },
          visibilityConfig: visibility("ApiRateLimit"),
        },
      ],
    });
  }
}
