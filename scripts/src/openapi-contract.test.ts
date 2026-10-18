import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { openApiPath } from "./paths.js";

describe("ask API contract", () => {
  it("defines POST /ask with the scaffold request and response fields", () => {
    const document = parse(readFileSync(openApiPath, "utf8")) as {
      paths: {
        "/ask": {
          post: {
            responses: Record<string, unknown>;
          };
        };
      };
      components: {
        schemas: {
          AskRequest: { required: string[]; properties: { mode: { enum: string[] } } };
          AskResponse: { required: string[] };
          ErrorResponse: { required: string[] };
          ChatMessage: { properties: { role: { enum: string[] } } };
        };
      };
    };

    expect(document.paths["/ask"].post.responses["200"]).toBeTruthy();
    expect(document.paths["/ask"].post.responses["400"]).toBeTruthy();
    expect(document.paths["/ask"].post.responses["500"]).toBeTruthy();
    expect(document.paths["/ask"].post.responses["503"]).toBeTruthy();
    expect(document.components.schemas.AskRequest.required).toEqual(["question", "mode"]);
    expect(document.components.schemas.AskRequest.properties.mode.enum).toEqual([
      "career_question",
      "job_comparison",
    ]);
    expect(document.components.schemas.ChatMessage.properties.role.enum).toEqual([
      "user",
      "assistant",
    ]);
    expect(document.components.schemas.AskResponse.required).toEqual([
      "answer",
      "citations",
      "suggestedQuestions",
      "requestId",
    ]);
    expect(document.components.schemas.ErrorResponse.required).toEqual(["message", "requestId"]);
  });
});
