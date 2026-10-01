import "dotenv/config";
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
  CallToolResult,
  TextContent,
  CallToolRequest
} from '@modelcontextprotocol/sdk/types.js';
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface DatabaseConfig {
  path: string;
  readonly?: boolean;
}

// NOUVEAUTÉ : Support multi-databases avec Map
interface DatabaseInstance {
  db: Database.Database;
  config: DatabaseConfig;
}

class SQLiteServer {
  private server: Server;
  private databases: Map<string, DatabaseInstance> = new Map();
  private defaultDbAlias: string = "default";

  constructor() {
    this.server = new Server(
      {
        name: "sqlite-mcp-server-multi",
        version: "2.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();

    this.server.onerror = (error: Error) => {};
    process.on("SIGINT", async () => {
      // Fermer toutes les connexions
      for (const [alias, instance] of this.databases) {
        instance.db.close();
      }
      await this.server.close();
      process.exit(0);
    });
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "connect_database",
            description: "Connect to a SQLite database file with an alias for multi-db support",
            inputSchema: {
              type: "object",
              properties: {
                path: {
                  type: "string",
                  description: "Path to the SQLite database file",
                },
                alias: {
                  type: "string",
                  description: "Alias to reference this database (default: 'default')",
                  default: "default",
                },
                readonly: {
                  type: "boolean",
                  description: "Open database in read-only mode",
                  default: false,
                },
              },
              required: ["path"],
            },
          },
          {
            name: "attach_database",
            description: "Attach another database to the current connection (SQLite ATTACH)",
            inputSchema: {
              type: "object",
              properties: {
                path: {
                  type: "string",
                  description: "Path to the database to attach",
                },
                alias: {
                  type: "string",
                  description: "Alias name for the attached database",
                },
                db_alias: {
                  type: "string",
                  description: "Main database alias to attach to (default: 'default')",
                  default: "default",
                },
              },
              required: ["path", "alias"],
            },
          },
          {
            name: "list_databases",
            description: "List all connected databases and their aliases",
            inputSchema: {
              type: "object",
              properties: {},
            },
          },
          {
            name: "switch_database",
            description: "Switch the default database alias for subsequent operations",
            inputSchema: {
              type: "object",
              properties: {
                alias: {
                  type: "string",
                  description: "Alias of the database to switch to",
                },
              },
              required: ["alias"],
            },
          },
          {
            name: "list_tables",
            description: "List all tables in the specified database",
            inputSchema: {
              type: "object",
              properties: {
                db_alias: {
                  type: "string",
                  description: "Database alias to query (default: current default)",
                  default: "default",
                },
              },
            },
          },
          {
            name: "describe_table",
            description: "Get the schema/structure of a specific table",
            inputSchema: {
              type: "object",
              properties: {
                table_name: {
                  type: "string",
                  description: "Name of the table to describe",
                },
                db_alias: {
                  type: "string",
                  description: "Database alias to query (default: current default)",
                  default: "default",
                },
              },
              required: ["table_name"],
            },
          },
          {
            name: "query_data",
            description: "Execute a SELECT query on the database",
            inputSchema: {
              type: "object",
              properties: {
                query: {
                  type: "string",
                  description: "SQL SELECT query to execute",
                },
                limit: {
                  type: "number",
                  description: "Maximum number of rows to return",
                  default: 100,
                },
                db_alias: {
                  type: "string",
                  description: "Database alias to query (default: current default)",
                  default: "default",
                },
              },
              required: ["query"],
            },
          },
          {
            name: "execute_query",
            description: "Execute any SQL query (INSERT, UPDATE, DELETE, etc.)",
            inputSchema: {
              type: "object",
              properties: {
                query: {
                  type: "string",
                  description: "SQL query to execute",
                },
                db_alias: {
                  type: "string",
                  description: "Database alias to query (default: current default)",
                  default: "default",
                },
              },
              required: ["query"],
            },
          },
          {
            name: "get_table_info",
            description: "Get comprehensive information about a table including schema, indexes, and sample data",
            inputSchema: {
              type: "object",
              properties: {
                table_name: {
                  type: "string",
                  description: "Name of the table to analyze",
                },
                sample_rows: {
                  type: "number",
                  description: "Number of sample rows to return",
                  default: 5,
                },
                db_alias: {
                  type: "string",
                  description: "Database alias to query (default: current default)",
                  default: "default",
                },
              },
              required: ["table_name"],
            },
          },
        ] satisfies Tool[],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case "connect_database":
            return await this.connectDatabase(args as { path: string; alias?: string; readonly?: boolean });

          case "attach_database":
            return await this.attachDatabase(args as { path: string; alias: string; db_alias?: string });

          case "list_databases":
            return await this.listDatabases();

          case "switch_database":
            return await this.switchDatabase(args as { alias: string });

          case "list_tables":
            return await this.listTables(args as { db_alias?: string });

          case "describe_table":
            return await this.describeTable(args as { table_name: string; db_alias?: string });

          case "query_data":
            return await this.queryData(args as { query: string; limit?: number; db_alias?: string });

          case "execute_query":
            return await this.executeQuery(args as { query: string; db_alias?: string });

          case "get_table_info":
            return await this.getTableInfo(args as { table_name: string; sample_rows?: number; db_alias?: string });

          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            } satisfies TextContent,
          ],
        } satisfies CallToolResult;
      }
    });
  }

  private async connectDatabase(args: { path: string; alias?: string; readonly?: boolean }): Promise<CallToolResult> {
    try {
      const alias = args.alias || "default";
      const dbPath = resolve(args.path);
      
      // Créer le dossier si nécessaire
      const dir = dirname(dbPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      // Fermer l'ancienne connexion si elle existe pour cet alias
      if (this.databases.has(alias)) {
        this.databases.get(alias)!.db.close();
      }

      const db = new Database(dbPath, { readonly: args.readonly || false });
      
      this.databases.set(alias, {
        db,
        config: { path: dbPath, readonly: args.readonly || false }
      });

      // Si c'est le premier connecté ou explicitement demandé, le mettre par défaut
      if (alias === "default" || this.databases.size === 1) {
        this.defaultDbAlias = alias;
      }

      const result = db.prepare("SELECT sqlite_version() as version").get() as { version: string };

      return {
        content: [
          {
            type: "text",
            text: `Successfully connected to database: ${dbPath}\nAlias: ${alias}\nSQLite version: ${result.version}\nTotal databases: ${this.databases.size}`,
          } satisfies TextContent,
        ],
      };
    } catch (error) {
      throw new Error(`Failed to connect to database: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async attachDatabase(args: { path: string; alias: string; db_alias?: string }): Promise<CallToolResult> {
    try {
      const mainAlias = args.db_alias || this.defaultDbAlias;
      const instance = this.databases.get(mainAlias);
      
      if (!instance) {
        throw new Error(`Main database alias '${mainAlias}' not found. Connect it first.`);
      }

      const attachPath = resolve(args.path);
      const attachAlias = args.alias;

      // Exécuter ATTACH DATABASE
      instance.db.prepare(`ATTACH DATABASE ? AS ?`).run(attachPath, attachAlias);

      return {
        content: [
          {
            type: "text",
            text: `Successfully attached database: ${attachPath}\nAs alias: ${attachAlias}\nTo main database: ${mainAlias}`,
          } satisfies TextContent,
        ],
      };
    } catch (error) {
      throw new Error(`Failed to attach database: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async listDatabases(): Promise<CallToolResult> {
    const dbList = [];
    for (const [alias, instance] of this.databases) {
      dbList.push(`- ${alias === this.defaultDbAlias ? "[DEFAULT] " : ""}${alias}: ${instance.config.path}`);
    }

    return {
      content: [
        {
          type: "text",
          text: `Connected databases (${this.databases.size}):\n${dbList.join("\n") || "No databases connected"}`,
        } satisfies TextContent,
      ],
    };
  }

  private async switchDatabase(args: { alias: string }): Promise<CallToolResult> {
    if (!this.databases.has(args.alias)) {
      throw new Error(`Database alias '${args.alias}' not found. Connect it first.`);
    }

    this.defaultDbAlias = args.alias;

    return {
      content: [
        {
          type: "text",
          text: `Switched to database alias: ${args.alias}\nPath: ${this.databases.get(args.alias)!.config.path}`,
        } satisfies TextContent,
      ],
    };
  }

  private getDb(alias?: string): Database.Database {
    const targetAlias = alias || this.defaultDbAlias;
    const instance = this.databases.get(targetAlias);
    
    if (!instance) {
      throw new Error(`No database connected for alias '${targetAlias}'. Use connect_database first.`);
    }
    
    return instance.db;
  }

  private async listTables(args: { db_alias?: string }): Promise<CallToolResult> {
    const db = this.getDb(args.db_alias);

    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as { name: string }[];

      const tableList = tables.map(t => t.name).join(", ");

      return {
        content: [
          {
            type: "text",
            text: `Tables in database '${args.db_alias || this.defaultDbAlias}' (${tables.length}): ${tableList || "No tables found"}`,
          } satisfies TextContent,
        ],
      };
    } catch (error) {
      throw new Error(`Failed to list tables: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async describeTable(args: { table_name: string; db_alias?: string }): Promise<CallToolResult> {
    const db = this.getDb(args.db_alias);

    try {
      const columns = db
        .prepare("PRAGMA table_info(?)")
        .all(args.table_name) as {
          cid: number;
          name: string;
          type: string;
          notnull: number;
          dflt_value: any;
          pk: number;
        }[];

      if (columns.length === 0) {
        throw new Error(`Table '${args.table_name}' not found`);
      }

      const schema = columns
        .map(col => {
          const nullable = col.notnull === 0 ? "NULL" : "NOT NULL";
          const pk = col.pk > 0 ? " PRIMARY KEY" : "";
          const defaultVal = col.dflt_value !== null ? ` DEFAULT ${col.dflt_value}` : "";
          return `  ${col.name} ${col.type} ${nullable}${pk}${defaultVal}`;
        })
        .join("\n");

      return {
        content: [
          {
            type: "text",
            text: `Table: ${args.table_name} (db: ${args.db_alias || this.defaultDbAlias})\n\nSchema:\n${schema}`,
          } satisfies TextContent,
        ],
      };
    } catch (error) {
      throw new Error(`Failed to describe table: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async queryData(args: { query: string; limit?: number; db_alias?: string }): Promise<CallToolResult> {
    const db = this.getDb(args.db_alias);

    try {
      const trimmedQuery = args.query.trim().toLowerCase();
      if (!trimmedQuery.startsWith("select")) {
        throw new Error("Only SELECT queries are allowed with query_data. Use execute_query for other operations.");
      }

      const limit = args.limit || 100;
      const queryWithLimit = args.query.toLowerCase().includes("limit")
        ? args.query
        : `${args.query} LIMIT ${limit}`;

      const results = db.prepare(queryWithLimit).all();

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "Query executed successfully. No rows returned.",
            } satisfies TextContent,
          ],
        };
      }

      const typedResults = results as Array<Record<string, unknown>>;
      const headers = Object.keys(typedResults[0] as Record<string, unknown>);
      const rows = typedResults.map((row: Record<string, unknown>) =>
        headers.map(header => String((row as Record<string, unknown>)[header] ?? "NULL")).join(" | ")
      );

      const headerRow = headers.join(" | ");
      const separator = headers.map(h => "-".repeat(h.length)).join("-|-");
      const table = [headerRow, separator, ...rows].join("\n");

      return {
        content: [
          {
            type: "text",
            text: `Database: ${args.db_alias || this.defaultDbAlias}\nQuery results (${results.length} rows):\n\n${table}`,
          } satisfies TextContent,
        ],
      };
    } catch (error) {
      throw new Error(`Query failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async executeQuery(args: { query: string; db_alias?: string }): Promise<CallToolResult> {
    const db = this.getDb(args.db_alias);

    try {
      const result = db.prepare(args.query).run();

      return {
        content: [
          {
            type: "text",
            text: `Database: ${args.db_alias || this.defaultDbAlias}\nQuery executed successfully. Changes: ${result.changes}, Last insert row ID: ${result.lastInsertRowid}`,
          } satisfies TextContent,
        ],
      };
    } catch (error) {
      throw new Error(`Query execution failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async getTableInfo(args: { table_name: string; sample_rows?: number; db_alias?: string }): Promise<CallToolResult> {
    const db = this.getDb(args.db_alias);

    try {
      const columns = db
        .prepare("PRAGMA table_info(?)")
        .all(args.table_name) as {
          cid: number;
          name: string;
          type: string;
          notnull: number;
          dflt_value: any;
          pk: number;
        }[];

      if (columns.length === 0) {
        throw new Error(`Table '${args.table_name}' not found`);
      }

      const countResult = db
        .prepare(`SELECT COUNT(*) as count FROM ${args.table_name}`)
        .get() as { count: number };

      const indexes = db
        .prepare("PRAGMA index_list(?)")
        .all(args.table_name) as { name: string; unique: number }[];

      const sampleRows = args.sample_rows || 5;
      const sampleData = db
        .prepare(`SELECT * FROM ${args.table_name} LIMIT ?`)
        .all(sampleRows);

      const schema = columns
        .map(col => {
          const nullable = col.notnull === 0 ? "NULL" : "NOT NULL";
          const pk = col.pk > 0 ? " PRIMARY KEY" : "";
          const defaultVal = col.dflt_value !== null ? ` DEFAULT ${col.dflt_value}` : "";
          return `  ${col.name} ${col.type} ${nullable}${pk}${defaultVal}`;
        })
        .join("\n");

      const indexInfo = indexes.length > 0
        ? indexes.map(idx => `  ${idx.name} (${idx.unique ? "UNIQUE" : "NON-UNIQUE"})`).join("\n")
        : "  No indexes";

      let sampleText = "";
      if (sampleData.length > 0) {
        const typedSample = sampleData as Array<Record<string, unknown>>;
        const headers = Object.keys(typedSample[0] as Record<string, unknown>);
        const rows = typedSample.map((row: Record<string, unknown>) =>
          headers.map(header => String((row as Record<string, unknown>)[header] ?? "NULL")).join(" | ")
        );

        const headerRow = headers.join(" | ");
        const separator = headers.map(h => "-".repeat(Math.max(h.length, 4))).join("-|-");
        sampleText = [headerRow, separator, ...rows].join("\n");
      } else {
        sampleText = "No data in table";
      }

      const info = `Database: ${args.db_alias || this.defaultDbAlias}
Table: ${args.table_name}
Row count: ${countResult.count}

Schema:
${schema}

Indexes:
${indexInfo}

Sample data (${Math.min(sampleRows, sampleData.length)} rows):
${sampleText}`;

      return {
        content: [
          {
            type: "text",
            text: info,
          } satisfies TextContent,
        ],
      };
    } catch (error) {
      throw new Error(`Failed to get table info: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    // Connexion auto aux bases configurées dans l'env
    const candidates = [
      { path: process.env.DEFAULT_DB_PATH, alias: "default" },
      { path: process.env.MEMORY_DB, alias: "memory" },
      { path: process.env.N8N_MAIN_DB, alias: "n8n_main" },
      { path: process.env.N8N_TEMPLATES_DB, alias: "n8n_templates" },
      { path: process.env.ORCHESTRATOR_DB, alias: "orchestrator" },
      { path: process.env.GRAPH_DB, alias: "graph" },
      { path: process.env.CACHE_DB, alias: "cache" },
      { path: process.env.ZVEC_DB, alias: "zvec" },
      { path: process.env.QDRANT_DB, alias: "qdrant" },
    ].filter(c => c.path && c.path.trim()).map(c => ({ path: c.path!.trim(), alias: c.alias }));

    for (const candidate of candidates) {
      if (!existsSync(candidate.path)) {
        // Créer le dossier si nécessaire
        const dir = dirname(candidate.path);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
      }
      try {
        await this.connectDatabase({ path: candidate.path, alias: candidate.alias, readonly: false });
      } catch (err) {
        // Silencieusement ignorer les erreurs de connexion auto
      }
    }
  }
}

const server = new SQLiteServer();
server.run().catch(() => {});
