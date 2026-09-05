import { describe, expect, it } from "vitest";
import { isBootError, parseAddColumn, REPLICATION_PLACEHOLDER, renderStatement, splitStatements } from "./migrate.js";

describe("doris migrator helpers", () => {
  it("retries only cluster-warming errors, never a bad statement", () => {
    expect(isBootError(new Error("connect ECONNREFUSED 127.0.0.1:9030"))).toBe(true);
    expect(isBootError(new Error("errCode = 2, detailMessage = Failed to find enough backend, need 1"))).toBe(true);
    expect(isBootError(new Error("replication num should be less than the number of available backends"))).toBe(true);
    expect(isBootError(Object.assign(new Error("x"), { fatal: true }))).toBe(true);
    expect(isBootError(new Error("errCode = 2, detailMessage = Syntax error in line 1"))).toBe(false);
    expect(isBootError(new Error("Unknown column 'nope' in 'default_cluster:memoturn.traces'"))).toBe(false);
  });

  it("recognises ADD COLUMN statements so they can be skipped when already applied", () => {
    expect(parseAddColumn("ALTER TABLE observations ADD COLUMN cache_read_tokens BIGINT NOT NULL DEFAULT '0'")).toEqual(
      {
        table: "observations",
        column: "cache_read_tokens",
      },
    );
    expect(parseAddColumn("alter table `traces` add column `session_path` VARCHAR(1024)")).toEqual({
      table: "traces",
      column: "session_path",
    });
    expect(parseAddColumn("CREATE TABLE IF NOT EXISTS traces (x INT)")).toBeNull();
    expect(parseAddColumn("ALTER TABLE traces DROP COLUMN x")).toBeNull();
  });

  it("substitutes the replication placeholder and splits statements ignoring comments", () => {
    expect(renderStatement(`PROPERTIES ("replication_num" = "${REPLICATION_PLACEHOLDER}")`, 3)).toBe(
      'PROPERTIES ("replication_num" = "3")',
    );
    expect(splitStatements("-- a comment;\nCREATE TABLE a (x INT);\n\nALTER TABLE a ADD COLUMN y INT;\n")).toEqual([
      "CREATE TABLE a (x INT)",
      "ALTER TABLE a ADD COLUMN y INT",
    ]);
  });
});
