import { verifyToken } from "./jwt";
import type { Request } from "./types";

// Returns null when the request carries no bearer token.
export async function currentUser(req: Request) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const claims = await verifyToken(header.slice(7));
  return { id: claims.sub, name: claims.name };
}
