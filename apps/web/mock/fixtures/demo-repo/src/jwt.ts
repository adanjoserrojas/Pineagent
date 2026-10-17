export type Claims = { sub: string; name: string };

export async function verifyToken(token: string): Promise<Claims> {
  if (!token) throw new Error("empty token");
  return { sub: "user-1", name: "Demo User" };
}
