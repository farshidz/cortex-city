import { expect, test } from "@playwright/test";

const config = {
  default_agent_runner: "codex",
  default_permission_mode: "yolo",
  default_codex_model: "gpt-5.6-sol",
  max_parallel_sessions: 10,
  poll_interval_seconds: 30,
};

for (const width of [900, 760]) {
  test(`settings helper text follows its control at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    // All configuration is isolated from the developer's settings.
    await page.route("**/api/config", (route) =>
      route.fulfill(
        route.request().method() === "PUT"
          ? { status: 400, json: { error: "Could not save these settings" } }
          : { json: config },
      ),
    );
    await page.route("**/api/reviews/learnings", (route) =>
      route.fulfill({ json: { content: "", enabled: true } }),
    );
    await page.goto("/settings");
    await page
      .getByRole("button", { name: "Reviewer General, prompts & learnings" })
      .click();
    await page
      .getByText("Usage limits & exempt authors", { exact: false })
      .click();
    for (const label of [
      "Default Reviewer Model",
      "Review Debounce (seconds)",
      "Weekly Codex Usage Limit (%)",
      "Authors Exempt from Usage Limit",
    ]) {
      const input = page.getByLabel(label, { exact: true });
      await input.scrollIntoViewIfNeeded();
      const rectangles = await input.evaluate((element) => {
        const row = element.parentElement!;
        const labelRect = row.querySelector("label")!.getBoundingClientRect();
        const controlRect = element.getBoundingClientRect();
        const helpRect = row.querySelector("p")!.getBoundingClientRect();
        return {
          labelBottom: labelRect.bottom,
          controlTop: controlRect.top,
          controlBottom: controlRect.bottom,
          helpTop: helpRect.top,
        };
      });
      expect(
        rectangles.controlTop,
        `${label}: control follows label`,
      ).toBeGreaterThanOrEqual(rectangles.labelBottom);
      expect(
        rectangles.helpTop,
        `${label}: help follows control`,
      ).toBeGreaterThanOrEqual(rectangles.controlBottom);
    }
    // Saving from a lower section must keep the API error in view too.
    await page
      .getByLabel("Weekly Codex Usage Limit (%)", { exact: true })
      .fill("90");
    await page
      .getByLabel("Authors Exempt from Usage Limit", { exact: true })
      .scrollIntoViewIfNeeded();
    const save = page.getByRole("button", {
      name: "Save changes",
      exact: true,
    });
    const saveRect = await save.boundingBox();
    expect(saveRect!.y).toBeGreaterThanOrEqual(0);
    expect(saveRect!.y + saveRect!.height).toBeLessThanOrEqual(900);
    await save.click();
    const alert = page
      .getByRole("alert")
      .filter({ hasText: "Could not save these settings" });
    await expect(alert).toBeVisible();
    const alertRect = await alert.boundingBox();
    expect(alertRect!.y).toBeGreaterThanOrEqual(0);
    expect(alertRect!.y + alertRect!.height).toBeLessThanOrEqual(900);
  });
}
