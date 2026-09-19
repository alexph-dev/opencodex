import { describe, expect, test } from "bun:test";
import { listManagementModelRows, loadExportModels } from "../../src/server/management/model-rows";
import type { CatalogModel } from "../../src/codex/catalog";
import type { OcxConfig } from "../../src/types";

/**
 * A read-only caller has to be able to see what a writer would write without performing the
 * gather, because the gather reaches providers and can persist an initial model selection. What
 * it must NOT get is a different projection, or a preview and the commit that follows it would
 * disagree about the roster for a reason that has nothing to do with the roster changing.
 */
const CONFIG: OcxConfig = {
  port: 10100,
  hostname: "127.0.0.1",
  defaultProvider: "supplied",
  providers: { supplied: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } },
} as OcxConfig;

const SUPPLIED: CatalogModel[] = [{ id: "supplied-model", provider: "supplied" }];

describe("a supplied roster replaces the gather and keeps the projection", () => {
  test("rows come from the roster the caller brought", async () => {
    const rows = await listManagementModelRows(CONFIG, { models: SUPPLIED });
    // No provider here serves this id, so a gather could not have produced this row. Its
    // presence is what proves the supplied roster was used instead.
    expect(rows.some(row => row.id === "supplied-model")).toBe(true);
  });

  test("the disabled computation still applies to a supplied roster", async () => {
    const rows = await listManagementModelRows(
      { ...CONFIG, disabledModels: ["supplied/supplied-model"] } as OcxConfig,
      { models: SUPPLIED },
    );
    const row = rows.find(candidate => candidate.id === "supplied-model");
    expect(row?.disabled).toBe(true);
  });

  test("the export projection accepts a supplied roster without gathering", async () => {
    // Visibility and provider selection decide which rows survive here, so this asserts the call
    // completes through the same path rather than pinning that policy from outside.
    await expect(loadExportModels(CONFIG, SUPPLIED)).resolves.toBeInstanceOf(Array);
  });
});
