import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VIEWER_REQUEST_SOURCE } from "../lib/portfolio-site-stack";

type Querystring = Record<string, { value: string; multiValue?: Array<{ value: string }> }>;
type ViewerRequest = {
  uri: string;
  headers: Record<string, { value: string }>;
  querystring: Querystring;
};
type ViewerResponse = {
  statusCode: number;
  statusDescription: string;
  headers: Record<string, { value: string }>;
};

const source = readFileSync(VIEWER_REQUEST_SOURCE, "utf8");
// The CloudFront runtime evaluates the file as a script that defines handler().
const handler = new Function(`${source}\nreturn handler;`)() as (event: {
  request: ViewerRequest;
}) => ViewerRequest | ViewerResponse;

function request(
  uri: string,
  host = "lucaselia.dev",
  querystring: Querystring = {},
): ViewerRequest {
  return { uri, headers: { host: { value: host } }, querystring };
}

function rewrite(uri: string): string {
  const result = handler({ request: request(uri) });
  if (!("uri" in result)) {
    throw new Error(`expected a request for ${uri}`);
  }
  return result.uri;
}

describe("site viewer-request function", () => {
  it("serves directory-format pages for extensionless paths and trailing slashes", () => {
    expect(rewrite("/")).toBe("/index.html");
    expect(rewrite("/experience/aws-sde-ii")).toBe("/experience/aws-sde-ii/index.html");
    expect(rewrite("/experience/aws-sde-ii/")).toBe("/experience/aws-sde-ii/index.html");
    expect(rewrite("/profile/lucas-elia")).toBe("/profile/lucas-elia/index.html");
  });

  it("leaves files with an extension alone", () => {
    for (const uri of [
      "/404.html",
      "/favicon.svg",
      "/robots.txt",
      "/sitemap-index.xml",
      "/_astro/index.DY7AcnAa.css",
      "/_astro/archivo-latin-wdth-normal.DY7AcnAa.woff2",
      "/experience/aws-sde-ii/index.html",
    ]) {
      expect(rewrite(uri)).toBe(uri);
    }
  });

  it("301-redirects www to the apex with the path and query", () => {
    const result = handler({
      request: request("/experience/aws-sde-ii", "WWW.lucaselia.dev", {
        utm_source: { value: "card" },
        tag: { value: "a", multiValue: [{ value: "a" }, { value: "b" }] },
        flag: { value: "" },
      }),
    });

    expect(result).toEqual({
      statusCode: 301,
      statusDescription: "Moved Permanently",
      headers: {
        location: {
          value: "https://lucaselia.dev/experience/aws-sde-ii?utm_source=card&tag=a&tag=b&flag",
        },
        "cache-control": { value: "max-age=3600" },
      },
    });
  });

  it("does not redirect the apex or another host", () => {
    expect("uri" in handler({ request: request("/", "lucaselia.dev") })).toBe(true);
    expect("uri" in handler({ request: request("/", "d111111abcdef8.cloudfront.net") })).toBe(true);
  });

  it("stays within the CloudFront Functions size limit and plain-script syntax", () => {
    expect(Buffer.byteLength(source)).toBeLessThan(10 * 1024);
    expect(source).not.toMatch(/\b(import|export|require)\b/);
  });
});
