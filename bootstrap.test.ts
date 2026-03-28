import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

test("workspace bootstrap", () => {
  expect(true).toBe(true);
});

test("github actions ci runs validation on push", () => {
  const workflowPath = join(process.cwd(), ".github", "workflows", "ci.yml");

  expect(existsSync(workflowPath)).toBe(true);

  const workflow = readFileSync(workflowPath, "utf8");

  expect(workflow).toContain("on:");
  expect(workflow).toContain("push:");
  expect(workflow).toContain("pull_request:");
  expect(workflow).toContain("uses: actions/checkout@v6");
  expect(workflow).toContain("uses: oven-sh/setup-bun@v2");
  expect(workflow).toContain("uses: rhysd/action-setup-vim@v1");
  expect(workflow).toContain("bun install --frozen-lockfile");
  expect(workflow).toContain("bun run check");
  expect(workflow).toContain("bun test");
  expect(workflow).toContain("bun run test:nvim");
});
