import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { ZodError } from "zod";

/** Error de dominio con código estable para el cliente y estado HTTP. */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new DomainError("NOT_FOUND", 404, `${what} no existe`);
export const forbidden = (msg = "No tienes permiso para esta acción") => new DomainError("FORBIDDEN", 403, msg);
export const invalid = (msg: string, details?: unknown) => new DomainError("VALIDATION_FAILED", 422, msg, details);
export const conflict = (code: string, msg: string, details?: unknown) => new DomainError(code, 409, msg, details);

/** Respuestas de error en formato application/problem+json. */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly log = new Logger("ProblemFilter");

  catch(err: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    let status = 500;
    let body: Record<string, unknown> = { code: "INTERNAL", title: "Error interno. Ya lo estamos revisando." };

    if (err instanceof DomainError) {
      status = err.status;
      body = { code: err.code, title: err.message, ...(err.details !== undefined ? { details: err.details } : {}) };
    } else if (err instanceof ZodError) {
      status = 422;
      body = {
        code: "VALIDATION_FAILED",
        title: "Hay datos inválidos en la solicitud",
        details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      };
    } else if (err instanceof HttpException) {
      status = err.getStatus();
      body = { code: status === 404 ? "NOT_FOUND" : "HTTP_ERROR", title: err.message };
    } else {
      this.log.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    }
    void reply.status(status).header("content-type", "application/problem+json").send({ status, ...body });
  }
}
