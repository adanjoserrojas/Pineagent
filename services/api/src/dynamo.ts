// The lock and file store in DynamoDB (contracts/SOCKET_LOCKS_AND_FILES.md, "Restart recovery").
//
//   pineagent-locks  PK room  SK path   kind, holder, at, ttl          one item per editor lock
//   pineagent-files  PK room  SK path   version, editors (string set), at, ttl
//
// `room` is the Socket.IO room name ("ws:<owner/repo>:<branch>"). Credentials come from the
// instance role (the SDK asks the instance metadata service); there are no keys in config.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, PutCommand, QueryCommand, UpdateCommand, type QueryCommandInput } from "@aws-sdk/lib-dynamodb";
import type { RoomStore, Store, StoredFile, StoredLock } from "@pineagent/core/server";

// Items nobody has touched for this long are deleted by DynamoDB (TTL): a lock left behind by a
// room that never reopened, or the bookkeeping of a branch nobody uses any more.
const LOCK_TTL_S = 7 * 86_400;
const FILE_TTL_S = 30 * 86_400;

export type DynamoTables = { locks: string; files: string };
type Send = Pick<DynamoDBDocumentClient, "send">;

export function dynamoClient(region: string): DynamoDBDocumentClient {
  // Short timeouts: lock acks wait for these writes, and a stuck request must not freeze editing.
  const client = new DynamoDBClient({ region, maxAttempts: 3, requestHandler: { connectionTimeout: 1_000, requestTimeout: 2_000 } });
  return DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
}

export class DynamoStore implements Store {
  constructor(
    private readonly db: Send,
    private readonly tables: DynamoTables,
    private readonly now: () => number = Date.now,
  ) {}

  room(room: string): RoomStore {
    const { db, tables } = this;
    const stamp = (ttlS: number) => {
      const ms = this.now();
      return { at: new Date(ms).toISOString(), ttl: Math.floor(ms / 1000) + ttlS };
    };
    return {
      load: async () => {
        const [locks, files] = await Promise.all([this.query(tables.locks, room), this.query(tables.files, room)]);
        return {
          locks: locks.map((i): StoredLock => ({ path: i.path, kind: i.kind === "dir" ? "dir" : "file", holder: i.holder })),
          files: files
            .filter((i) => Number.isInteger(i.version))
            .map((i): StoredFile => ({ path: i.path, version: i.version, editors: i.editors ? [...i.editors] : [] })),
        };
      },
      putLock: async ({ path, kind, holder }) => {
        await db.send(new PutCommand({ TableName: tables.locks, Item: { room, path, kind, holder, ...stamp(LOCK_TTL_S) } }));
      },
      deleteLock: async (path) => {
        await db.send(new DeleteCommand({ TableName: tables.locks, Key: { room, path } }));
      },
      saveFile: async (path, version, editor) => {
        const { at, ttl } = stamp(FILE_TTL_S);
        await db.send(
          new UpdateCommand({
            TableName: tables.files,
            Key: { room, path },
            // `ttl` is a reserved word in DynamoDB expressions, hence the #names.
            UpdateExpression: `SET #v = :v, #at = :at, #ttl = :ttl${editor ? " ADD #e :e" : ""}`,
            ExpressionAttributeNames: { "#v": "version", "#at": "at", "#ttl": "ttl", ...(editor ? { "#e": "editors" } : {}) },
            ExpressionAttributeValues: { ":v": version, ":at": at, ":ttl": ttl, ...(editor ? { ":e": new Set([editor]) } : {}) },
          }),
        );
      },
      clearEditors: async (paths) => {
        await Promise.all(
          paths.map((path) =>
            db.send(
              new UpdateCommand({
                TableName: tables.files,
                Key: { room, path },
                UpdateExpression: "REMOVE #e",
                // Only touch items that exist; a REMOVE on a missing item would create an empty one.
                ConditionExpression: "attribute_exists(#p)",
                ExpressionAttributeNames: { "#e": "editors", "#p": "path" },
              }),
            ).catch((err: { name?: string }) => {
              if (err?.name !== "ConditionalCheckFailedException") throw err;
            }),
          ),
        );
      },
    };
  }

  // All of one room's items. Strongly consistent: a restart right after a write must see it.
  private async query(table: string, room: string): Promise<Record<string, any>[]> {
    const items: Record<string, any>[] = [];
    let start: QueryCommandInput["ExclusiveStartKey"];
    do {
      const page = await this.db.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: "#r = :r",
          ExpressionAttributeNames: { "#r": "room" },
          ExpressionAttributeValues: { ":r": room },
          ConsistentRead: true,
          ExclusiveStartKey: start,
        }),
      );
      items.push(...(page.Items ?? []));
      start = page.LastEvaluatedKey;
    } while (start);
    return items;
  }
}
