// Flujo completo contra Postgres real: registro, onboarding, agenda, reserva pública y aislamiento.
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { addDays } from "@salon/kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

let app: NestFastifyApplication;
const run = Date.now().toString(36);

type Res = { status: number; body: any; cookie?: string };

async function call(method: string, url: string, opts: { body?: unknown; cookie?: string; tenant?: string; key?: string } = {}): Promise<Res> {
  const res = await app.getHttpAdapter().getInstance().inject({
    method: method as "GET",
    url,
    payload: opts.body as object | undefined,
    headers: {
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.tenant ? { "x-tenant-id": opts.tenant } : {}),
      ...(opts.key ? { "idempotency-key": opts.key } : {}),
      origin: "http://localhost:5173",
    },
  });
  const setCookie = res.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []).map((c) => c.split(";")[0]).join("; ");
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, cookie: cookie || undefined };
}

async function signUp(name: string): Promise<string> {
  const res = await call("POST", "/api/auth/sign-up/email", {
    body: { name, email: `${name.toLowerCase()}-${run}@test.pe`, password: "clave-segura-123" },
  });
  expect(res.status).toBe(200);
  expect(res.cookie).toBeTruthy();
  return res.cookie!;
}

/** Próximo lunes (fecha local de Lima) para tener la agenda vacía y dentro del horario por defecto. */
function nextMonday(): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date());
  for (let d = 1; d <= 7; d++) {
    const date = addDays(today, d);
    if (new Date(`${date}T12:00:00Z`).getUTCDay() === 1) return date;
  }
  throw new Error("unreachable");
}

let owner: string;
let tenantId: string;
let branchId: string;
let slug: string;
let serviceId: string;
let staffId: string;
const monday = nextMonday();

beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  owner = await signUp("Lucho");
  slug = `barberia-lucho-${run}`;
  const ob = await call("POST", "/v1/onboarding", { cookie: owner, body: { salonName: "Barbería Lucho", slug, template: "barberia" } });
  expect(ob.status).toBe(201);
  ({ tenantId, branchId } = ob.body);
  const services = await call("GET", "/v1/services", { cookie: owner, tenant: tenantId });
  serviceId = services.body.find((s: any) => s.name === "Corte de cabello").id;
  const staff = await call("GET", `/v1/staff?branchId=${branchId}`, { cookie: owner, tenant: tenantId });
  staffId = staff.body[0].id;
});

afterAll(async () => {
  await app?.close();
});

describe("agenda de recepción", () => {
  it("muestra disponibilidad dentro del horario por defecto (09:00–19:00, cada 15 min)", async () => {
    const res = await call("GET", `/v1/branches/${branchId}/availability?serviceId=${serviceId}&date=${monday}`, { cookie: owner, tenant: tenantId });
    expect(res.status).toBe(200);
    expect(res.body.slots[0].start).toBe(`${monday}T14:00:00.000Z`); // 09:00 Lima
    expect(res.body.slots.at(-1).start).toBe(`${monday}T23:30:00.000Z`); // 18:30 + 30 min = 19:00
  });

  it("crea una cita, es idempotente y rechaza el doble agendamiento con alternativas", async () => {
    const body = { branchId, serviceId, staffId, startsAt: `${monday}T15:00:00.000Z`, newClient: { fullName: "Rosa Quispe", phone: "987 654 321" } };
    const first = await call("POST", "/v1/appointments", { cookie: owner, tenant: tenantId, body, key: "k-1" });
    expect(first.status).toBe(201);
    expect(first.body.status).toBe("confirmed");

    const retry = await call("POST", "/v1/appointments", { cookie: owner, tenant: tenantId, body, key: "k-1" });
    expect(retry.status).toBe(201);
    expect(retry.body.id).toBe(first.body.id);

    const clash = await call("POST", "/v1/appointments", {
      cookie: owner,
      tenant: tenantId,
      body: { branchId, serviceId, staffId, startsAt: `${monday}T15:15:00.000Z`, newClient: { fullName: "Otra Persona" } },
    });
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe("SLOT_TAKEN");
    expect(clash.body.details.alternatives[0].start).toBe(`${monday}T15:30:00.000Z`);
  });

  it("cancelar libera el horario", async () => {
    const created = await call("POST", "/v1/appointments", {
      cookie: owner, tenant: tenantId,
      body: { branchId, serviceId, staffId, startsAt: `${monday}T17:00:00.000Z`, newClient: { fullName: "Carla" } },
    });
    const cancel = await call("POST", `/v1/appointments/${created.body.id}/status`, { cookie: owner, tenant: tenantId, body: { status: "cancelled" } });
    expect(cancel.status).toBe(200);
    const again = await call("POST", "/v1/appointments", {
      cookie: owner, tenant: tenantId,
      body: { branchId, serviceId, staffId, startsAt: `${monday}T17:00:00.000Z`, newClient: { fullName: "Daniela" } },
    });
    expect(again.status).toBe(201);
  });

  it("rechaza horarios fuera del turno salvo que recepción lo fuerce", async () => {
    const body = { branchId, serviceId, staffId, startsAt: `${monday}T12:00:00.000Z`, newClient: { fullName: "Madrugador" } }; // 07:00 Lima
    expect((await call("POST", "/v1/appointments", { cookie: owner, tenant: tenantId, body })).status).toBe(422);
    expect((await call("POST", "/v1/appointments", { cookie: owner, tenant: tenantId, body: { ...body, allowOutsideHours: true } })).status).toBe(201);
  });

  it("la vista del día lista citas con su clienta", async () => {
    const res = await call("GET", `/v1/branches/${branchId}/agenda?date=${monday}`, { cookie: owner, tenant: tenantId });
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: any) => i.clientName)).toContain("Rosa Quispe");
  });
});

describe("equipo", () => {
  it("un estilista nuevo nace con horario y servicios, y queda disponible", async () => {
    const created = await call("POST", "/v1/staff", {
      cookie: owner, tenant: tenantId,
      body: { branchId, displayName: "Kevin", serviceIds: [serviceId] },
    });
    expect(created.status).toBe(201);
    const avail = await call("GET", `/v1/branches/${branchId}/availability?serviceId=${serviceId}&date=${monday}&staffId=${created.body.id}`, { cookie: owner, tenant: tenantId });
    expect(avail.body.slots[0].start).toBe(`${monday}T14:00:00.000Z`);
  });

  it("se edita nombre, horario y se desactiva", async () => {
    const created = await call("POST", "/v1/staff", { cookie: owner, tenant: tenantId, body: { branchId, displayName: "Temporal", serviceIds: [serviceId] } });
    const id = created.body.id;
    expect((await call("PATCH", `/v1/staff/${id}`, { cookie: owner, tenant: tenantId, body: { displayName: "Kiara", color: "#0E7C66" } })).status).toBe(200);
    expect((await call("PUT", `/v1/staff/${id}/schedule`, { cookie: owner, tenant: tenantId, body: { weekly: [{ weekday: 1, start: "14:00", end: "18:00" }] } })).status).toBe(200);
    const avail = await call("GET", `/v1/branches/${branchId}/availability?serviceId=${serviceId}&date=${monday}&staffId=${id}`, { cookie: owner, tenant: tenantId });
    expect(avail.body.slots[0].start).toBe(`${monday}T19:00:00.000Z`); // 14:00 Lima

    await call("PATCH", `/v1/staff/${id}`, { cookie: owner, tenant: tenantId, body: { active: false } });
    const list = await call("GET", `/v1/staff?branchId=${branchId}`, { cookie: owner, tenant: tenantId });
    const kiara = list.body.find((s: any) => s.id === id);
    expect(kiara).toMatchObject({ displayName: "Kiara", color: "#0E7C66", active: false });
    const after = await call("GET", `/v1/branches/${branchId}/availability?serviceId=${serviceId}&date=${monday}&staffId=${id}`, { cookie: owner, tenant: tenantId });
    expect(after.body.slots).toEqual([]);
  });
});

describe("reserva pública", () => {
  it("hold + confirmación crean la cita y la clienta", async () => {
    const salon = await call("GET", `/v1/public/${slug}`);
    expect(salon.status).toBe(200);
    expect(salon.body.name).toBe("Barbería Lucho");

    const avail = await call("GET", `/v1/public/${slug}/availability?serviceId=${serviceId}&date=${monday}&staffId=${staffId}`);
    expect(avail.body.slots.map((s: any) => s.start)).not.toContain(`${monday}T15:00:00.000Z`);

    const hold = await call("POST", `/v1/public/${slug}/holds`, { body: { serviceId, staffId, startsAt: `${monday}T20:00:00.000Z` }, key: "h-1" });
    expect(hold.status).toBe(201);

    const competitor = await call("POST", `/v1/public/${slug}/holds`, { body: { serviceId, staffId, startsAt: `${monday}T20:00:00.000Z` } });
    expect(competitor.status).toBe(409);

    const confirm = await call("POST", `/v1/public/${slug}/holds/${hold.body.holdId}/confirm`, {
      body: { fullName: "María Torres", phone: "+51 912 345 678", acceptReminders: true, acceptPrivacy: true },
    });
    expect(confirm.status).toBe(200);
    expect(confirm.body.status).toBe("confirmed");
    expect(confirm.body.serviceName).toBe("Corte de cabello");
  });

  it("un slug inexistente responde 404", async () => {
    expect((await call("GET", "/v1/public/no-existe-este-salon")).status).toBe(404);
  });
});

describe("aislamiento entre salones", () => {
  it("otro usuario no puede operar en un salón ajeno", async () => {
    const intruder = await signUp("Intruso");
    const res = await call("GET", "/v1/clients", { cookie: intruder, tenant: tenantId });
    expect(res.status).toBe(403);
  });

  it("sin sesión no hay acceso", async () => {
    expect((await call("GET", "/v1/services", { tenant: tenantId })).status).toBe(401);
  });

  it("un salón nuevo no ve los clientes de otro", async () => {
    const other = await signUp("Ana");
    const ob = await call("POST", "/v1/onboarding", { cookie: other, body: { salonName: "Salón Ana", slug: `salon-ana-${run}`, template: "peluqueria" } });
    const clients = await call("GET", "/v1/clients?q=Rosa", { cookie: other, tenant: ob.body.tenantId });
    expect(clients.status).toBe(200);
    expect(clients.body).toEqual([]);
  });
});
