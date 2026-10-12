// Crea un salón de demostración para desarrollo local, usando la API real (mismas reglas que producción).
// Uso: con la API corriendo en :3000 ->  node scripts/seed-demo.ts
// Credenciales de prueba SOLO para entorno local:
export const DEMO_EMAIL = "demo@turnito.test";
export const DEMO_PASSWORD = "demo-local-12345";

const API = process.env.API_URL ?? "http://localhost:3000";

async function call(path: string, body: unknown, cookie?: string, tenant?: string) {
  const res = await fetch(`${API}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:5173",
      ...(cookie ? { cookie } : {}),
      ...(tenant ? { "x-tenant-id": tenant } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const cookies = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, cookie: cookies };
}

let auth = await call("/api/auth/sign-in/email", { email: DEMO_EMAIL, password: DEMO_PASSWORD });
if (auth.status !== 200) {
  auth = await call("/api/auth/sign-up/email", { name: "Lucho Ramírez", email: DEMO_EMAIL, password: DEMO_PASSWORD });
}
if (auth.status !== 200) throw new Error(`No se pudo iniciar sesión: ${JSON.stringify(auth.body)}`);
const cookie = auth.cookie;

const me = await call("/v1/me", undefined, cookie);
let tenantId: string = me.body.salons[0]?.tenantId;
if (!tenantId) {
  const ob = await call("/v1/onboarding", { salonName: "Barbería Don Lucho", slug: "barberia-don-lucho", template: "barberia", ownerDisplayName: "Lucho" }, cookie);
  if (ob.status !== 201) throw new Error(JSON.stringify(ob.body));
  tenantId = ob.body.tenantId;

  const branches = await call("/v1/branches", undefined, cookie, tenantId);
  const branchId = branches.body[0].id;
  const services = await call("/v1/services", undefined, cookie, tenantId);
  const staff = await call("/v1/staff", { branchId, displayName: "Kevin", color: "#0E7C66", serviceIds: services.body.map((s: { id: string }) => s.id) }, cookie, tenantId);
  await fetch(`${API}/v1/staff/${staff.body.id}/schedule`, {
    method: "PUT",
    headers: { "content-type": "application/json", origin: "http://localhost:5173", cookie, "x-tenant-id": tenantId },
    body: JSON.stringify({ weekly: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: "10:00", end: "20:00" })) }),
  });

  // Algunas citas de hoy y mañana para que la agenda no arranque vacía.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date());
  const tomorrow = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date(Date.now() + 86_400_000));
  const people = [
    ["Rosa Quispe", "987654321"], ["Jorge Mamani", "912345678"], ["Lucía Flores", "923456789"],
    ["Diego Huamán", "934567890"], ["Valeria Rojas", "945678901"],
  ];
  const times = ["10:00", "11:30", "15:00", "16:30", "18:00"];
  for (const [d, date] of [today, tomorrow].entries()) {
    for (const [i, [fullName, phone]] of people.entries()) {
      await call("/v1/appointments", {
        branchId,
        serviceId: services.body[i % services.body.length].id,
        startsAt: new Date(`${date}T${times[(i + d) % times.length]}:00-05:00`).toISOString(),
        newClient: { fullName, phone },
      }, cookie, tenantId);
    }
  }
}
console.log(`Demo lista. Panel: http://localhost:5173  ·  Reserva pública: http://localhost:5173/reservar/barberia-don-lucho`);
console.log(`Usuario de prueba en apps/api/scripts/seed-demo.ts`);
