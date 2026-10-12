import { Global, Module } from "@nestjs/common";
import { uuidv7 } from "@salon/kernel";
import { betterAuth } from "better-auth";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { config } from "../config.js";
import { AUTH_POOL } from "./database.js";

export const AUTH = Symbol("AUTH");

export function createAuth(pool: pg.Pool) {
  return betterAuth({
    database: pool,
    baseURL: config.baseUrl,
    basePath: "/api/auth",
    secret: config.authSecret,
    trustedOrigins: [...config.webOrigins],
    emailAndPassword: { enabled: true, minPasswordLength: 8, autoSignIn: true },
    session: {
      expiresIn: 60 * 60 * 24 * 30, // 30 días, renovación deslizante
      updateAge: 60 * 60 * 24,
    },
    advanced: { database: { generateId: () => uuidv7() } },
    telemetry: { enabled: false },
  });
}

export type Auth = ReturnType<typeof createAuth>;

@Global()
@Module({
  providers: [{ provide: AUTH, inject: [AUTH_POOL], useFactory: (pool: pg.Pool) => createAuth(pool) }],
  exports: [AUTH],
})
export class AuthModule {}

export function toWebHeaders(raw: Record<string, string | string[] | undefined>): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(key, v);
  }
  return headers;
}

/** Monta el handler de Better Auth (/api/auth/*) directamente sobre Fastify. */
export function mountAuthRoutes(fastify: FastifyInstance, auth: Auth): void {
  fastify.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    handler: async (req, reply) => {
      const url = new URL(req.url, config.baseUrl);
      const request = new Request(url, {
        method: req.method,
        headers: toWebHeaders(req.headers),
        body: req.method === "GET" || req.body === undefined ? undefined : JSON.stringify(req.body),
      });
      const res = await auth.handler(request);
      reply.status(res.status);
      res.headers.forEach((value, key) => {
        if (key !== "set-cookie") void reply.header(key, value);
      });
      const cookies = res.headers.getSetCookie();
      if (cookies.length) void reply.header("set-cookie", cookies);
      return reply.send(res.body ? await res.text() : null);
    },
  });
}
