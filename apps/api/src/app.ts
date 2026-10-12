import "reflect-metadata";
import { Controller, Get, Inject, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import type pg from "pg";
import { config } from "./config.js";
import { AgendaController } from "./modules/agenda/agenda.controller.js";
import { StaffController } from "./modules/agenda/staff.controller.js";
import { PublicBookingController } from "./modules/booking/public-booking.controller.js";
import { CatalogModule } from "./modules/catalog/catalog.js";
import { CrmModule } from "./modules/crm/clients.js";
import { IamModule } from "./modules/iam/onboarding.js";
import { AUTH, type Auth, AuthModule, mountAuthRoutes } from "./platform/auth.js";
import { DatabaseModule, PG_POOL } from "./platform/database.js";
import { ProblemFilter } from "./platform/errors.js";

@Controller()
class HealthController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  @Get("healthz")
  async health() {
    await this.pool.query("SELECT 1");
    return { ok: true };
  }
}

@Module({ controllers: [AgendaController, StaffController] })
class AgendaModule {}

@Module({ controllers: [PublicBookingController] })
class BookingModule {}

@Module({
  imports: [DatabaseModule, AuthModule, IamModule, CatalogModule, CrmModule, AgendaModule, BookingModule],
  controllers: [HealthController],
})
export class AppModule {}

export async function createApp(): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ trustProxy: true }), {
    logger: process.env.NODE_ENV === "test" ? false : ["log", "warn", "error"],
  });
  app.enableCors({
    origin: [...config.webOrigins],
    credentials: true,
    allowedHeaders: ["content-type", "x-tenant-id", "idempotency-key"],
  });
  app.useGlobalFilters(new ProblemFilter());
  mountAuthRoutes(app.getHttpAdapter().getInstance(), app.get<Auth>(AUTH));
  app.enableShutdownHooks();
  return app;
}
