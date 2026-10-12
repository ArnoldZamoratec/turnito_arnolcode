import { Global, Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { createPool, runtimeUrl } from "@salon/db";
import pg from "pg";

export const PG_POOL = Symbol("PG_POOL");
export const AUTH_POOL = Symbol("AUTH_POOL");

@Global()
@Module({
  providers: [
    { provide: PG_POOL, useFactory: () => createPool() },
    // Better Auth trabaja sobre el esquema "auth" (identidad global, sin tenant).
    {
      provide: AUTH_POOL,
      useFactory: () => new pg.Pool({ connectionString: runtimeUrl(), max: 5, options: "-c search_path=auth" }),
    },
  ],
  exports: [PG_POOL, AUTH_POOL],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(AUTH_POOL) private readonly authPool: pg.Pool,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([this.pool.end(), this.authPool.end()]);
  }
}
