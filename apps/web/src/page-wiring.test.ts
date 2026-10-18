import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("index page", () => {
  it("mounts the assistant as a client island", () => {
    const source = readFileSync(join(process.cwd(), "src/pages/index.astro"), "utf8");

    expect(source).toContain("<Assistant");
    expect(source).toContain("client:load");
    expect(source).toContain("import.meta.env.PUBLIC_ASK_API_URL");
    expect(source).toContain("import.meta.env.PUBLIC_ASK_STREAMING");
    expect(source).toContain("askApiUrl={askApiUrl}");
    expect(source).toContain("modelStreaming={modelStreaming}");
  });
});
