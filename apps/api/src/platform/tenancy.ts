import {
  applyDecorators,
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
  UseGuards,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { UUID_RE } from "@salon/kernel";
import type { FastifyRequest } from "fastify";
import type pg from "pg";
import { AUTH, type Auth, toWebHeaders } from "./auth.js";
import { PG_POOL } from "./database.js";
import { DomainError, forbidden } from "./errors.js";

export type Role = "owner" | "admin" | "receptionist" | "stylist";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

/** Contexto de cada request autenticado dentro de un salón. Nunca se arma con datos del body. */
export interface TenantContext {
  tenantId: string;
  userId: string;
  role: Role;
  /** null = todas las sucursales */
  branchIds: string[] | null;
}

type Req = FastifyRequest & { user?: SessionUser; tenant?: TenantContext };

const ROLES_KEY = "roles";

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(AUTH) private readonly auth: Auth) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Req>();
    const session = await this.auth.api.getSession({ headers: toWebHeaders(req.headers) });
    if (!session) throw new DomainError("UNAUTHENTICATED", 401, "Inicia sesión para continuar");
    req.user = { id: session.user.id, email: session.user.email, name: session.user.name };
    return true;
  }
}

/**
 * Resuelve el salón activo. El header X-Tenant-Id solo ELIGE entre los salones del usuario:
 * la membresía se verifica en la BD en cada request, así que un id ajeno se rechaza.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Req>();
    const tenantId = req.headers["x-tenant-id"];
    if (typeof tenantId !== "string" || !UUID_RE.test(tenantId)) {
      throw new DomainError("TENANT_REQUIRED", 400, "Falta el encabezado X-Tenant-Id con el salón activo");
    }
    const { rows } = await this.pool.query<{ tenant_id: string; role: Role; branch_ids: string[] | null }>(
      "SELECT tenant_id, role, branch_ids FROM core.memberships_for_user($1) WHERE tenant_id = $2",
      [req.user!.id, tenantId],
    );
    const m = rows[0];
    if (!m) throw forbidden("No perteneces a este salón");

    const allowed = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (allowed && !allowed.includes(m.role)) throw forbidden();

    req.tenant = { tenantId: m.tenant_id, userId: req.user!.id, role: m.role, branchIds: m.branch_ids };
    return true;
  }
}

/** Ruta autenticada sin salón (onboarding, perfil). */
export const Authenticated = () => UseGuards(SessionGuard);

/** Ruta dentro de un salón; opcionalmente restringida a ciertos roles. */
export const InTenant = (...roles: Role[]) =>
  applyDecorators(SetMetadata(ROLES_KEY, roles.length ? roles : undefined), UseGuards(SessionGuard, TenantGuard));

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<Req>().user!);
export const Ctx = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<Req>().tenant!);

/** Regla de propiedad: la sucursal debe estar entre las asignadas al usuario. */
export function assertBranchAccess(ctx: TenantContext, branchId: string): void {
  if (ctx.branchIds && !ctx.branchIds.includes(branchId)) throw forbidden("No tienes acceso a esta sucursal");
}
