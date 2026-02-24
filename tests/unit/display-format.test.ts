import { describe, it, expect } from "vitest";
import { stripMarkdownAndNormalize, formatForDisplay } from "../../src/display-format.js";

describe("stripMarkdownAndNormalize", () => {
  it("removes markdown markers without fusing words", () => {
    const input = "1. *This* is a **test** response";
    const result = stripMarkdownAndNormalize(input);
    expect(result).toBe("1. This is a test response");
  });

  it("removes emojis", () => {
    const input = "Hello 👋 world 🌍";
    const result = stripMarkdownAndNormalize(input);
    expect(result).toBe("Hello world");
  });

  it("joins common split words like fort nite", () => {
    const input = "Fort nite is popular";
    const result = stripMarkdownAndNormalize(input);
    expect(result.toLowerCase()).toContain("fortnite");
  });
});

describe("formatForDisplay", () => {
  it("creates heading and numbered items for multiple sentences", () => {
    const input = "This is a heading sentence. This is the first detail. This is the second detail.";
    const result = formatForDisplay(input);
    const lines = result.split("\n");
    expect(lines[0]).toBe("This is a heading sentence");
    expect(lines[1]).toBe("1. This is the first detail");
    expect(lines[2]).toBe("2. This is the second detail");
  });

  it("strips leading numeric markers from heading and items", () => {
    const input = "1. This is a test response. 2. Use this mode to verify your pipelines.";
    const result = formatForDisplay(input);
    const lines = result.split("\n");
    expect(lines[0]).toBe("This is a test response");
    expect(lines[1]).toBe("1. Use this mode to verify your pipelines");
  });
});

