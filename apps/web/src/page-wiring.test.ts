import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("index page", () => {
  it("mounts the assistant as a client island", () => {
    const source = readFileSync(join(process.cwd(), "src/pages/index.astro"), "utf8");

    expect(source).toContain("<Assistant");
    expect(source).toContain("client:load");
    // The build profile decides: production always uses /api/ask, streamed (site-profile.ts).
    expect(source).toContain("assistantConfig(siteEnv())");
    expect(source).toContain("developmentDetails={developmentDetails}");
    expect(source).toContain("askApiUrl={askApiUrl}");
    expect(source).toContain("modelStreaming={modelStreaming}");
  });
});
