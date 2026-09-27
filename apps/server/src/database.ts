import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import mysql, { type PoolConnection, type ResultSetHeader } from "mysql2/promise";

type Row = Record<string, any>;
type Parameters = unknown[];
export interface Statement {
  get(...args: Parameters): Promise<Row | undefined>;
  all(...args: Parameters): Promise<Row[]>;
  run(...args: Parameters): Promise<{ changes: number; lastInsertRowid: number }>;
}
export interface Database {
  driver: "mysql" | "sqlite";
  prepare(sql: string): Statement;
  exec(sql: string): Promise<void>;
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  forUpdate: string;
  sql(sqlite: string, mysql: string): string;
  close(): Promise<void>;
}

export function databaseDriver(): "mysql" | "sqlite" {
  const nodeController = process.env.NEXIOUS_NODE_CONTROLLER === "1";
  const driver = process.env.NEXIOUS_DB_DRIVER || (nodeController ? "sqlite" : "mysql");
  if (driver !== "mysql" && driver !== "sqlite") throw new Error("NEXIOUS_DB_DRIVER 只支持 mysql 或 sqlite");
  if (driver === "sqlite" && !nodeController && process.env.NEXIOUS_SQLITE_TEST !== "1")
    throw new Error("主控业务数据必须使用 MySQL；SQLite 仅用于边缘节点、历史迁移读取和隔离测试");
  return driver;
}

export async function openDatabase(): Promise<Database> {
  const driver = databaseDriver();
  if (driver === "mysql") {
    const uri = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
    if (uri && uri.protocol !== "mysql:") throw new Error("DATABASE_URL 必须使用 mysql:// 协议");
    const database = uri ? decodeURIComponent(uri.pathname.slice(1)) : process.env.NEXIOUS_MYSQL_DATABASE;
    const user = uri ? decodeURIComponent(uri.username) : process.env.NEXIOUS_MYSQL_USER;
    if (!database || !user) throw new Error("请配置 MySQL 数据库名称和专用数据库用户");
    const pool = mysql.createPool({
      host: uri?.hostname || process.env.NEXIOUS_MYSQL_HOST || "127.0.0.1",
      port: Number(uri?.port || process.env.NEXIOUS_MYSQL_PORT || 3306), user,
      password: uri ? decodeURIComponent(uri.password) : process.env.NEXIOUS_MYSQL_PASSWORD,
      database, charset: "utf8mb4", timezone: "Z", dateStrings: true,
      connectionLimit: Math.min(50, Math.max(1, Number(process.env.NEXIOUS_MYSQL_POOL_SIZE || 10))),
      waitForConnections: true, queueLimit: 100, connectTimeout: 10000,
      enableKeepAlive: true, multipleStatements: false,
      ssl: process.env.NEXIOUS_MYSQL_SSL_CA ? { ca: readFileSync(process.env.NEXIOUS_MYSQL_SSL_CA), rejectUnauthorized: true } : undefined
    });
    const context = new AsyncLocalStorage<PoolConnection>();
    const execute = async (sql: string, args: Parameters = []) => {
      // 保留 SQLite 风格的具名绑定，种子数据也通过参数绑定写入。
      const values = sql.includes("@") && args.length === 1 && typeof args[0] === "object" && args[0] !== null
        ? [...sql.matchAll(/@(\w+)/g)].map(match => (args[0] as Row)[match[1]]) : args;
      const [result] = await (context.getStore() || pool).execute(sql.replace(/@(\w+)/g, "?"), values.map(value => value === undefined ? null : value));
      return result;
    };
    try { await pool.query("SELECT 1"); }
    catch { await pool.end(); throw new Error("MySQL 连接失败，请检查数据库地址、权限和 TLS 配置"); }
    return {
      driver, forUpdate: " FOR UPDATE", sql: (_sqlite, mysqlSql) => mysqlSql,
      prepare: sql => ({
        all: async (...args) => await execute(sql, args) as Row[],
        get: async (...args) => (await execute(sql, args) as Row[])[0],
        run: async (...args) => { const result = await execute(sql, args) as ResultSetHeader; return { changes: result.affectedRows, lastInsertRowid: result.insertId }; }
      }),
      exec: async sql => { await execute(sql); },
      transaction: async operation => {
        const current = context.getStore();
        if (current) {
          const savepoint = `nested_${randomUUID().replaceAll("-", "")}`;
          await current.query(`SAVEPOINT ${savepoint}`);
          try {
            const result = await operation();
            await current.query(`RELEASE SAVEPOINT ${savepoint}`);
            return result;
          } catch (error) {
            await current.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
            await current.query(`RELEASE SAVEPOINT ${savepoint}`);
            throw error;
          }
        }
        const connection = await pool.getConnection();
        try {
          await connection.beginTransaction();
          const result = await context.run(connection, operation);
          await connection.commit(); return result;
        } catch (error) { await connection.rollback(); throw error; }
        finally { connection.release(); }
      },
      close: () => pool.end()
    };
  }
  const path = process.env.NEXIOUS_DB_PATH || resolve(process.cwd(), "data/nexious.db");
  mkdirSync(dirname(path), { recursive: true });
  const require = createRequire(import.meta.url);
  let Constructor;
  try { Constructor = require("node:sqlite").DatabaseSync; } catch { Constructor = require("better-sqlite3"); }
  const sqlite = new Constructor(path);
  sqlite.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  // SQLite 用于边缘节点和隔离测试；历史迁移通过只读连接读取源文件。
  const context = new AsyncLocalStorage<boolean>();
  let tail: Promise<unknown> = Promise.resolve();
  function exclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    if (context.getStore()) return Promise.resolve().then(operation);
    const pending = tail.then(() => context.run(true, operation));
    tail = pending.catch(() => {}); return pending;
  }
  return {
    driver, forUpdate: "", sql: sqliteSql => sqliteSql,
    prepare: sql => ({
      all: (...args) => exclusive(() => sqlite.prepare(sql).all(...args)),
      get: (...args) => exclusive(() => sqlite.prepare(sql).get(...args)),
      run: (...args) => exclusive(() => sqlite.prepare(sql).run(...args))
    }),
    exec: sql => exclusive(() => sqlite.exec(sql)),
    transaction: operation => {
      if (context.getStore()) return operation();
      return exclusive(async () => {
      sqlite.exec("BEGIN IMMEDIATE");
      try { const result = await operation(); sqlite.exec("COMMIT"); return result; }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
      });
    },
    close: () => exclusive(() => sqlite.close())
  };
}
