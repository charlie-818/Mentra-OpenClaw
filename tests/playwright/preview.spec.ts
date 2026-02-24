import { test, expect } from "@playwright/test";

test("preview page formats output with heading and numbered list", async ({ page }) => {
  await page.goto("/preview");

  const prompt = "Test structured formatting for preview.";
  await page.fill("#prompt", prompt);
  await page.click("#sendBtn");

  const contentLocator = page.locator("#content");
  await expect(contentLocator).toContainText("Test structured formatting", { timeout: 15000 });

  const text = await contentLocator.innerText();
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  expect(lines.length).toBeGreaterThanOrEqual(1);
  const heading = lines[0];
  expect(heading.length).toBeGreaterThan(0);

  const hasNumbered = lines.some((l) => /^\d+\.\s+/.test(l));
  expect(hasNumbered).toBe(true);

  expect(text.includes("*")).toBe(false);
  expect(text.includes("#")).toBe(false);
}
);

