const env = process.env;

export const config = {
  port: Number(env.PORT ?? 3000),
  /** URL pública de la API (Better Auth la usa para cookies y redirecciones). */
  baseUrl: env.API_BASE_URL ?? `http://localhost:${env.PORT ?? 3000}`,
  /** Orígenes del panel y de la página pública que pueden llamar a la API con cookies. */
  webOrigins: (env.WEB_ORIGINS ?? "http://localhost:5173,http://localhost:4321").split(",").map((s) => s.trim()),
  authSecret:
    env.BETTER_AUTH_SECRET ??
    (env.NODE_ENV === "production"
      ? (() => {
          throw new Error("BETTER_AUTH_SECRET es obligatorio en producción");
        })()
      : "dev-only-secret-change-me-dev-only-secret"),
  /** Minutos que se reserva un horario mientras la clienta completa sus datos. */
  holdMinutes: 5,
  /** Anticipación mínima para reservas desde la página pública. */
  publicMinLeadMin: 30,
  /** Días hacia adelante que se pueden reservar. */
  horizonDays: 60,
} as const;
