import assert from "node:assert/strict";
import { test } from "node:test";
import { databaseDriver } from "./database.js";

test("主控默认 MySQL，边缘节点默认 SQLite，主控不得回退到 SQLite", () => {
  const keys = ["NEXIOUS_DB_DRIVER", "NEXIOUS_NODE_CONTROLLER", "NEXIOUS_SQLITE_TEST"] as const;
  const previous = keys.map(key => process.env[key]);
  try {
    for (const key of keys) delete process.env[key];
    assert.equal(databaseDriver(), "mysql");
    process.env.NEXIOUS_DB_DRIVER = "sqlite";
    assert.throws(databaseDriver, /主控业务数据必须使用 MySQL/);
    delete process.env.NEXIOUS_DB_DRIVER;
    process.env.NEXIOUS_NODE_CONTROLLER = "1";
    assert.equal(databaseDriver(), "sqlite");
    delete process.env.NEXIOUS_NODE_CONTROLLER;
    process.env.NEXIOUS_SQLITE_TEST = "1";
    process.env.NEXIOUS_DB_DRIVER = "sqlite";
    assert.equal(databaseDriver(), "sqlite");
    process.env.NEXIOUS_DB_DRIVER = "invalid";
    assert.throws(databaseDriver, /只支持/);
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});
