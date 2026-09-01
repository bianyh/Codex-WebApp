import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import argon2 from "argon2";
import type { FastifyRequest, FastifyReply } from "fastify";
import { getState, persistState } from "./state.js";
import { config } from "./config.js";

const COOKIE = "codex_console_session";
const SESSION_BYTES = 32;
const maxAttempts = new Map<string, { count: number; resetAt: number }>();

function tokenHash(token: string): string { return createHash("sha256").update(token).digest("hex"); }

export function cookieName(): string { return COOKIE; }

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id, memoryCost: 64 * 1024, timeCost: 3, parallelism: 1 });
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try { return await argon2.verify(hash, password); } catch { return false; }
}

export async function setPassword(password: string): Promise<void> {
  if (password.length < 12) throw new Error("密码至少需要 12 个字符");
  getState().passwordHash = await hashPassword(password);
  await persistState();
}

function clientKey(request: FastifyRequest): string { return request.ip || "unknown"; }

function allowedAttempt(request: FastifyRequest): boolean {
  const now = Date.now();
  const key = clientKey(request);
  const value = maxAttempts.get(key);
  if (!value || value.resetAt <= now) { maxAttempts.set(key, { count: 1, resetAt: now + 60_000 }); return true; }
  if (value.count >= 5) return false;
  value.count += 1;
  return true;
}

export async function login(request: FastifyRequest, reply: FastifyReply, password: string): Promise<boolean> {
  if (!allowedAttempt(request)) { reply.code(429).send({ ok: false, error: { code: "rate_limited", message: "尝试次数过多，请稍后再试", retryable: true } }); return false; }
  const hash = getState().passwordHash;
  if (!hash || !(await verifyPassword(password, hash))) { reply.code(401).send({ ok: false, error: { code: "invalid_password", message: "密码错误", retryable: false } }); return false; }
  const token = randomBytes(SESSION_BYTES).toString("base64url");
  const now = new Date();
  const expires = new Date(now.getTime() + config.sessionDays * 86_400_000);
  getState().sessions = getState().sessions.filter((item) => !item.revokedAt && new Date(item.expiresAt).getTime() > now.getTime());
  getState().sessions.push({ tokenHash: tokenHash(token), createdAt: now.toISOString(), lastSeenAt: now.toISOString(), expiresAt: expires.toISOString() });
  await persistState();
  reply.setCookie(COOKIE, token, { httpOnly: true, sameSite: "strict", secure: request.protocol === "https", path: "/", maxAge: config.sessionDays * 86_400 });
  reply.send({ ok: true, data: { expiresAt: expires.toISOString() }, requestId: String(request.id) });
  return true;
}

export async function authenticated(request: FastifyRequest): Promise<boolean> {
  const token = request.cookies?.[COOKIE];
  if (!token) return false;
  const hash = tokenHash(token);
  const session = getState().sessions.find((item) => !item.revokedAt && item.tokenHash.length === hash.length && timingSafeEqual(Buffer.from(item.tokenHash), Buffer.from(hash)));
  if (!session || new Date(session.expiresAt).getTime() <= Date.now()) return false;
  session.lastSeenAt = new Date().toISOString();
  return true;
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  if (await authenticated(request)) return true;
  reply.code(401).send({ ok: false, error: { code: "unauthenticated", message: "需要登录", retryable: false }, requestId: String(request.id) });
  return false;
}

export async function logout(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = request.cookies?.[COOKIE];
  if (token) {
    const hash = tokenHash(token);
    const session = getState().sessions.find((item) => item.tokenHash === hash);
    if (session) session.revokedAt = new Date().toISOString();
    await persistState();
  }
  reply.clearCookie(COOKIE, { path: "/" }).send({ ok: true, data: null, requestId: String(request.id) });
}
