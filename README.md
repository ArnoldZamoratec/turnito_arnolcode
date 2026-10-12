# Turnito

Agenda, reservas por enlace y (pronto) caja para peluquerías y barberías en Perú.
"Turnito" es un nombre de trabajo. La arquitectura completa está en [`docs/arquitectura.md`](docs/arquitectura.md).

## Requisitos

- Node 22+ (probado con Node 24)
- No necesitas Docker ni PostgreSQL instalado: `pnpm db:start` descarga y levanta un Postgres local.

## Arrancar en local

```bash
corepack pnpm install
corepack pnpm db:start           # deja Postgres corriendo en :54329 (otra terminal)
corepack pnpm db:migrate         # aplica migraciones a salon_dev
NODE_ENV=test corepack pnpm db:migrate   # y a salon_test (para los tests)

corepack pnpm --filter @salon/kernel build
corepack pnpm --filter @salon/db build
corepack pnpm --filter @salon/api build
corepack pnpm --filter @salon/api start  # API en :3000
corepack pnpm --filter @salon/web dev    # Panel en :5173

node apps/api/scripts/seed-demo.ts       # salón de demostración con citas
```

- Panel: http://localhost:5173 (usuario de prueba en `apps/api/scripts/seed-demo.ts`)
- Reserva pública: http://localhost:5173/reservar/barberia-don-lucho

## Tests

```bash
corepack pnpm --filter @salon/db test      # RLS entre tenants y constraint anti-solapamiento
corepack pnpm --filter @salon/kernel test  # zonas horarias, dinero, intervalos
corepack pnpm --filter @salon/api test     # disponibilidad + e2e contra Postgres real
```

## Estructura

```text
apps/api        NestJS + Fastify: auth, onboarding, catálogo, clientes, agenda, reserva pública
apps/web        PWA React + Vite: panel del salón y página de reserva
packages/db     migraciones SQL, RLS, withTenant()
packages/kernel tiempo por zona horaria, dinero en céntimos, UUIDv7, intervalos
docs/           arquitectura y decisiones
```

## Reglas que no se rompen

1. Todo acceso a datos de negocio pasa por `withTenant()`; la BD aplica RLS forzada.
2. Ninguna migración ya aplicada se edita: se crea una nueva.
3. Dinero en céntimos (`integer`), instantes en `timestamptz`, horarios laborales en hora local + zona IANA.
4. Que dos citas no se solapen lo garantiza el constraint `EXCLUDE` de `agenda.staff_bookings`, no el código.
