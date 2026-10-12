import { uuidv7 } from "@salon/kernel";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useMemo, useState } from "react";
import { type AgendaItem, api, ApiError, type Client, type Salon, type Service, type Slot, type Staff } from "../lib/api";
import { addDays, localToIso, longDate, minutesFromMidnight, money, shortDate, timeIn, today, waLink } from "../lib/format";
import { Button, Chip, ErrorBox, Field, Sheet } from "../components/ui";

interface Branch {
  id: string;
  name: string;
  timezone: string;
  bookingSlug: string;
  slotStepMin: number;
}

const PX_PER_MIN = 1.6;

const STATUS: Record<string, { label: string; cls: string }> = {
  confirmed: { label: "Confirmada", cls: "bg-plum-50 border-plum-500 text-plum-700" },
  checked_in: { label: "En atención", cls: "bg-amber-100 border-amber-700 text-amber-700" },
  completed: { label: "Atendida", cls: "bg-mint-100 border-mint-600 text-mint-600" },
  no_show: { label: "No vino", cls: "bg-rose-100 border-rose-700 text-rose-700 line-through" },
  held: { label: "Reservando…", cls: "bg-card border-dashed border-plum-500 text-muted" },
  conflict: { label: "En conflicto", cls: "bg-rose-100 border-rose-700 text-rose-700" },
};

export function AgendaPage({ salon, userName, onSwitchSalon }: { salon: Salon; userName: string; onSwitchSalon?: () => void }) {
  const branches = useQuery({ queryKey: ["branches", salon.tenantId], queryFn: () => api<Branch[]>("/v1/branches") });
  const branch = branches.data?.[0];
  if (branches.error) return <ErrorBox error={branches.error} />;
  if (!branch) return <p className="p-6 text-muted">Cargando agenda…</p>;
  return <AgendaBoard salon={salon} branch={branch} userName={userName} onSwitchSalon={onSwitchSalon} />;
}

function AgendaBoard({ salon, branch, userName, onSwitchSalon }: { salon: Salon; branch: Branch; userName: string; onSwitchSalon?: () => void }) {
  const tz = branch.timezone;
  const [date, setDate] = useState(() => today(tz));
  const [newAt, setNewAt] = useState<{ staffId?: string; time?: string } | null>(null);
  const [selected, setSelected] = useState<AgendaItem | null>(null);
  const [copied, setCopied] = useState(false);

  const staff = useQuery({ queryKey: ["staff", branch.id], queryFn: () => api<Staff[]>(`/v1/staff?branchId=${branch.id}`) });
  const services = useQuery({ queryKey: ["services"], queryFn: () => api<Service[]>("/v1/services") });
  const agenda = useQuery({
    queryKey: ["agenda", branch.id, date],
    queryFn: () => api<{ items: AgendaItem[] }>(`/v1/branches/${branch.id}/agenda?date=${date}`),
    refetchInterval: 30_000, // la recepción y el estilista ven los cambios del otro sin recargar
  });

  const columns = (staff.data ?? []).filter((s) => s.active);
  const { gridStart, gridEnd } = useMemo(() => {
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay() || 7;
    const ranges = columns.flatMap((s) => s.weekly.filter((w) => w.weekday === weekday));
    const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
    const start = Math.min(8 * 60, ...ranges.map((r) => toMin(r.start)));
    const end = Math.max(20 * 60, ...ranges.map((r) => toMin(r.end)));
    return { gridStart: Math.floor(start / 60) * 60, gridEnd: Math.ceil(end / 60) * 60 };
  }, [columns, date]);

  const hours = Array.from({ length: (gridEnd - gridStart) / 60 }, (_, i) => gridStart / 60 + i);
  const days = Array.from({ length: 7 }, (_, i) => addDays(today(tz), i));
  const bookingUrl = `${location.origin}/reservar/${branch.bookingSlug}`;
  const dayTotal = (agenda.data?.items ?? [])
    .filter((i) => i.kind === "service" && i.status !== "no_show")
    .reduce((acc, i) => acc + (i.priceCents ?? 0), 0);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(bookingUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copia tu enlace de reservas", bookingUrl);
    }
  };

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-20 border-b border-line bg-paper/95 px-4 pt-[calc(env(safe-area-inset-top,0px)+12px)] pb-3 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <button onClick={onSwitchSalon} className="truncate font-display text-xl font-bold" disabled={!onSwitchSalon}>
              {salon.name}
            </button>
            <p className="text-sm text-muted">{longDate(date)}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={copyLink} className="text-sm">
              {copied ? "¡Enlace copiado!" : "Copiar enlace de reservas"}
            </Button>
            <Button variant="ghost" className="text-sm" onClick={() => api("/api/auth/sign-out", { body: {}, tenant: false }).then(() => location.reload())}>
              Salir
            </Button>
          </div>
        </div>
        <nav className="mx-auto mt-3 flex max-w-6xl gap-2 overflow-x-auto pb-1" aria-label="Días">
          {days.map((d) => (
            <Chip key={d} active={d === date} onClick={() => setDate(d)}>
              <span>{d === today(tz) ? "Hoy" : shortDate(d)}</span>
            </Chip>
          ))}
          <input
            type="date"
            aria-label="Elegir otra fecha"
            value={date}
            onChange={(e) => e.target.value && setDate(e.target.value)}
            className="min-h-10 rounded-full border border-line bg-card px-3 text-sm"
          />
        </nav>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pt-4 pb-28">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2 text-sm text-muted">
          <span>
            {(agenda.data?.items ?? []).filter((i) => i.kind === "service").length} citas · Hola, {userName.split(" ")[0]}
          </span>
          <span className="tabular">Previsto del día: <strong className="text-ink">{money(dayTotal)}</strong></span>
        </div>
        <ErrorBox error={agenda.error ?? staff.error} />
        {columns.length === 0 && staff.isSuccess ? (
          <p className="rounded-2xl border border-dashed border-line p-6 text-muted">Aún no hay estilistas activos en esta sucursal.</p>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-line bg-card">
            <div className="grid min-w-fit" style={{ gridTemplateColumns: `52px repeat(${columns.length}, minmax(132px, 1fr))` }}>
              <div className="sticky left-0 z-10 border-b border-line bg-card" />
              {columns.map((s) => (
                <div key={s.id} className="flex items-center gap-2 border-b border-l border-line px-3 py-2.5 font-medium">
                  <span className="size-2.5 rounded-full" style={{ background: s.color }} />
                  <span className="truncate">{s.displayName}</span>
                </div>
              ))}

              <div className="sticky left-0 z-10 bg-card" style={{ height: (gridEnd - gridStart) * PX_PER_MIN }}>
                {hours.map((h) => (
                  <div key={h} className="tabular absolute pr-2 text-right text-xs text-muted" style={{ top: (h * 60 - gridStart) * PX_PER_MIN - 7, width: 52 }}>
                    {String(h).padStart(2, "0")}:00
                  </div>
                ))}
              </div>
              {columns.map((s) => (
                <StaffColumn
                  key={s.id}
                  staffId={s.id}
                  items={(agenda.data?.items ?? []).filter((i) => i.staffId === s.id)}
                  date={date}
                  tz={tz}
                  gridStart={gridStart}
                  gridEnd={gridEnd}
                  onEmpty={(time) => setNewAt({ staffId: s.id, time })}
                  onItem={setSelected}
                />
              ))}
            </div>
          </div>
        )}
      </main>

      <Button
        className="fixed right-5 bottom-[calc(env(safe-area-inset-bottom,0px)+20px)] z-30 rounded-2xl px-6 shadow-lg shadow-plum-700/25"
        onClick={() => setNewAt({})}
      >
        + Nueva cita
      </Button>

      {newAt && services.data && (
        <NewAppointmentSheet
          branch={branch}
          date={date}
          initial={newAt}
          services={services.data.filter((s) => s.active)}
          staff={columns}
          onClose={() => setNewAt(null)}
        />
      )}
      {selected && <AppointmentSheet item={selected} tz={tz} salonName={salon.name} onClose={() => setSelected(null)} />}
    </div>
  );
}

function StaffColumn({
  items,
  date,
  tz,
  gridStart,
  gridEnd,
  onEmpty,
  onItem,
}: {
  staffId: string;
  items: AgendaItem[];
  date: string;
  tz: string;
  gridStart: number;
  gridEnd: number;
  onEmpty: (time: string) => void;
  onItem: (i: AgendaItem) => void;
}) {
  const height = (gridEnd - gridStart) * PX_PER_MIN;
  return (
    <div
      className="relative cursor-copy border-l border-line"
      style={{
        height,
        backgroundImage: `repeating-linear-gradient(to bottom, var(--color-line) 0 1px, transparent 1px ${60 * PX_PER_MIN}px)`,
      }}
      onClick={(e) => {
        const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
        const min = Math.floor((gridStart + y / PX_PER_MIN) / 15) * 15;
        onEmpty(`${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`);
      }}
    >
      {items.map((i) => {
        const top = (minutesFromMidnight(i.start, date, tz) - gridStart) * PX_PER_MIN;
        const h = Math.max(((Date.parse(i.end) - Date.parse(i.start)) / 60000) * PX_PER_MIN - 2, 22);
        const st = i.kind === "block" ? { cls: "bg-[repeating-linear-gradient(45deg,var(--color-line)_0_6px,var(--color-card)_6px_12px)] border-line text-muted", label: "" } : (STATUS[i.status ?? ""] ?? STATUS.confirmed!);
        return (
          <button
            key={i.bookingId}
            className={`absolute inset-x-1 overflow-hidden rounded-lg border-l-4 px-2 text-left text-xs ${h < 40 ? "truncate py-0.5" : "py-1"} ${st.cls}`}
            style={{ top, height: h }}
            onClick={(e) => {
              e.stopPropagation();
              onItem(i);
            }}
          >
            <span className="tabular font-semibold">{timeIn(i.start, tz)}</span>{" "}
            <span className="font-medium">{i.kind === "block" ? (i.label ?? "Bloqueado") : (i.clientName ?? "Sin nombre")}</span>
            {i.serviceName && <span className={h < 40 ? "opacity-80" : "block truncate opacity-80"}>{h < 40 ? ` · ${i.serviceName}` : i.serviceName}</span>}
          </button>
        );
      })}
    </div>
  );
}

function NewAppointmentSheet({
  branch,
  date,
  initial,
  services,
  staff,
  onClose,
}: {
  branch: Branch;
  date: string;
  initial: { staffId?: string; time?: string };
  services: Service[];
  staff: Staff[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [idempotencyKey] = useState(() => uuidv7());
  const [serviceId, setServiceId] = useState(services[0]?.id ?? "");
  const [staffId, setStaffId] = useState(initial.staffId ?? "");
  const [day, setDay] = useState(date);
  const [time, setTime] = useState(initial.time ?? "");
  const [search, setSearch] = useState("");
  const [client, setClient] = useState<Client | null>(null);
  const [newClient, setNewClient] = useState({ fullName: "", phone: "" });
  const [notes, setNotes] = useState("");
  const [outsideHours, setOutsideHours] = useState(false);

  const eligibleStaff = staff.filter((s) => s.serviceIds.includes(serviceId));
  const slots = useQuery({
    queryKey: ["availability", branch.id, serviceId, day, staffId],
    queryFn: () =>
      api<{ slots: Slot[] }>(`/v1/branches/${branch.id}/availability?serviceId=${serviceId}&date=${day}${staffId ? `&staffId=${staffId}` : ""}`),
    enabled: Boolean(serviceId),
  });
  const clients = useQuery({
    queryKey: ["clients", search],
    queryFn: () => api<Client[]>(`/v1/clients?q=${encodeURIComponent(search)}`),
    enabled: search.trim().length >= 2 && !client,
  });

  const create = useMutation({
    mutationFn: () =>
      api("/v1/appointments", {
        idempotencyKey,
        body: {
          branchId: branch.id,
          serviceId,
          staffId: staffId || undefined,
          startsAt: localToIso(day, time, branch.timezone),
          clientId: client?.id,
          newClient: client ? undefined : { fullName: newClient.fullName || search, phone: newClient.phone || undefined },
          notes: notes || undefined,
          allowOutsideHours: outsideHours,
        },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["agenda"] });
      onClose();
    },
  });

  const alternatives = create.error instanceof ApiError && create.error.code === "SLOT_TAKEN"
    ? ((create.error.details as { alternatives?: Slot[] })?.alternatives ?? [])
    : [];

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  return (
    <Sheet title="Nueva cita" onClose={onClose}>
      <form onSubmit={onSubmit} className="grid gap-5">
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">Servicio</legend>
          <div className="flex flex-wrap gap-2">
            {services.map((s) => (
              <Chip key={s.id} active={s.id === serviceId} onClick={() => setServiceId(s.id)}>
                {s.name} · {money(s.priceCents)}
              </Chip>
            ))}
          </div>
        </fieldset>

        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">Con</legend>
          <div className="flex flex-wrap gap-2">
            <Chip active={!staffId} onClick={() => setStaffId("")}>Quien esté libre</Chip>
            {eligibleStaff.map((s) => (
              <Chip key={s.id} active={s.id === staffId} onClick={() => setStaffId(s.id)}>
                {s.displayName}
              </Chip>
            ))}
          </div>
        </fieldset>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Día" type="date" value={day} onChange={(e) => setDay(e.target.value)} required />
          <Field label="Hora" type="time" step={300} value={time} onChange={(e) => setTime(e.target.value)} required />
        </div>
        {slots.data && (
          <div className="grid gap-2">
            <span className="text-sm text-muted">{slots.data.slots.length ? "Horarios libres" : "No quedan horarios libres este día"}</span>
            <div className="flex max-h-32 flex-wrap gap-2 overflow-y-auto">
              {slots.data.slots.map((s) => {
                const t = timeIn(s.start, branch.timezone);
                return (
                  <Chip key={s.start} active={t === time} onClick={() => setTime(t)}>
                    <span className="tabular">{t}</span>
                  </Chip>
                );
              })}
            </div>
          </div>
        )}

        <div className="grid gap-2">
          {client ? (
            <div className="flex items-center justify-between rounded-xl border border-plum-500 bg-plum-50 px-3 py-2">
              <span>
                <strong>{client.fullName}</strong> <span className="text-sm text-muted">{client.phone}</span>
              </span>
              <button type="button" className="text-sm text-plum-700" onClick={() => setClient(null)}>Cambiar</button>
            </div>
          ) : (
            <>
              <Field label="Clienta o cliente" placeholder="Busca por nombre o teléfono" value={search} onChange={(e) => setSearch(e.target.value)} required={!newClient.fullName} />
              {clients.data && clients.data.length > 0 && (
                <ul className="grid gap-1">
                  {clients.data.map((c) => (
                    <li key={c.id}>
                      <button type="button" className="w-full rounded-xl px-3 py-2 text-left hover:bg-plum-50" onClick={() => setClient(c)}>
                        {c.fullName} <span className="text-sm text-muted">{c.phone}</span>
                        {c.noShowCount > 0 && <span className="ml-2 text-xs text-rose-700">{c.noShowCount} ausencias</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {search.trim().length >= 2 && (
                <Field
                  label={`Celular de ${search.trim()} (opcional)`}
                  inputMode="tel"
                  placeholder="987 654 321"
                  value={newClient.phone}
                  onChange={(e) => setNewClient({ fullName: search.trim(), phone: e.target.value })}
                  hint="Para enviarle el recordatorio por WhatsApp"
                />
              )}
            </>
          )}
        </div>

        <Field label="Nota (opcional)" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Ej.: trae foto del corte" />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={outsideHours} onChange={(e) => setOutsideHours(e.target.checked)} className="size-4 accent-plum-700" />
          Permitir fuera del horario del estilista
        </label>

        <ErrorBox error={create.error} />
        {alternatives.length > 0 && (
          <div className="flex flex-wrap gap-2">
            <span className="w-full text-sm text-muted">Horarios cercanos libres:</span>
            {alternatives.map((a) => (
              <Chip
                key={a.start}
                onClick={() => {
                  setDay(new Intl.DateTimeFormat("en-CA", { timeZone: branch.timezone }).format(new Date(a.start)));
                  setTime(timeIn(a.start, branch.timezone));
                  create.reset();
                }}
              >
                <span className="tabular">{timeIn(a.start, branch.timezone)}</span>
              </Chip>
            ))}
          </div>
        )}
        <Button type="submit" loading={create.isPending} disabled={!serviceId || !time}>
          Agendar
        </Button>
      </form>
    </Sheet>
  );
}

function AppointmentSheet({ item, tz, salonName, onClose }: { item: AgendaItem; tz: string; salonName: string; onClose: () => void }) {
  const qc = useQueryClient();
  const change = useMutation({
    mutationFn: (status: "checked_in" | "completed" | "cancelled" | "no_show") =>
      api(`/v1/appointments/${item.appointmentId}/status`, { body: { status } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["agenda"] });
      onClose();
    },
  });
  const unblock = useMutation({
    mutationFn: () => api(`/v1/blocks/${item.bookingId}`, { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["agenda"] });
      onClose();
    },
  });

  if (item.kind === "block") {
    return (
      <Sheet title={item.label ?? "Bloqueado"} onClose={onClose}>
        <p className="tabular mb-4 text-muted">{timeIn(item.start, tz)} – {timeIn(item.end, tz)}</p>
        <ErrorBox error={unblock.error} />
        <Button variant="danger" className="w-full" loading={unblock.isPending} onClick={() => unblock.mutate()}>Quitar bloqueo</Button>
      </Sheet>
    );
  }

  const reminder = `Hola ${item.clientName?.split(" ")[0] ?? ""}, te recordamos tu cita de ${item.serviceName ?? "hoy"} en ${salonName} a las ${timeIn(item.start, tz)}. Si no puedes venir, avísanos por aquí. ¡Te esperamos!`;
  const st = STATUS[item.status ?? "confirmed"];
  const open = item.status === "confirmed" || item.status === "checked_in";

  return (
    <Sheet title={item.clientName ?? "Cita"} onClose={onClose}>
      <dl className="mb-5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted">Servicio</dt>
        <dd>{item.serviceName}</dd>
        <dt className="text-muted">Hora</dt>
        <dd className="tabular">{timeIn(item.start, tz)} – {timeIn(item.end, tz)}</dd>
        <dt className="text-muted">Precio</dt>
        <dd className="tabular">{money(item.priceCents ?? 0)}</dd>
        <dt className="text-muted">Estado</dt>
        <dd>{st?.label}</dd>
        {item.notes && (
          <>
            <dt className="text-muted">Nota</dt>
            <dd>{item.notes}</dd>
          </>
        )}
        {item.clientNoShows ? (
          <>
            <dt className="text-muted">Historial</dt>
            <dd className="text-rose-700">{item.clientNoShows} ausencias anteriores</dd>
          </>
        ) : null}
      </dl>

      {item.clientPhone && (
        <a
          href={waLink(item.clientPhone, reminder)}
          target="_blank"
          rel="noopener"
          className="mb-3 flex min-h-11 items-center justify-center rounded-xl bg-mint-600 px-4 font-medium text-white"
        >
          Enviar recordatorio por WhatsApp
        </a>
      )}
      <ErrorBox error={change.error} />
      {open && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          {item.status === "confirmed" && <Button variant="secondary" onClick={() => change.mutate("checked_in")}>Llegó</Button>}
          <Button onClick={() => change.mutate("completed")}>Atendida</Button>
          {item.status === "confirmed" && <Button variant="secondary" onClick={() => change.mutate("no_show")}>No vino</Button>}
          <Button variant="danger" onClick={() => change.mutate("cancelled")}>Cancelar cita</Button>
        </div>
      )}
    </Sheet>
  );
}
