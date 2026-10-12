// Gestión del equipo: agregar estilistas y editar nombre, color, servicios y horario.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api, type Service, type Staff } from "../lib/api";
import { Button, Chip, ErrorBox, Field, Sheet } from "./ui";

const COLORS = ["#6366F1", "#0E7C66", "#C2410C", "#BE185D", "#0369A1", "#7C3AED", "#A16207", "#475569"];
const DAYS = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];

type Tramo = { weekday: number; start: string; end: string };
interface DayRow {
  on: boolean;
  start: string;
  end: string;
}

/** Plantilla semanal -> una fila por día (entrada/salida) + refrigerio común si lo había. */
function toRows(weekly: Tramo[]): { rows: DayRow[]; lunch: { start: string; end: string } | null } {
  let lunch: { start: string; end: string } | null = null;
  const rows = DAYS.map((_, i) => {
    const tramos = weekly.filter((w) => w.weekday === i + 1).sort((a, b) => a.start.localeCompare(b.start));
    if (!tramos.length) return { on: false, start: "09:00", end: "19:00" };
    if (tramos.length > 1 && !lunch) lunch = { start: tramos[0]!.end, end: tramos[1]!.start };
    return { on: true, start: tramos[0]!.start, end: tramos[tramos.length - 1]!.end };
  });
  return { rows, lunch };
}

/** Filas -> plantilla semanal, partiendo cada día en dos si el refrigerio cae dentro del turno. */
function toWeekly(rows: DayRow[], lunch: { start: string; end: string } | null): Tramo[] {
  return rows.flatMap((r, i) => {
    if (!r.on) return [];
    const weekday = i + 1;
    if (lunch && lunch.start < lunch.end && r.start < lunch.start && lunch.end < r.end) {
      return [
        { weekday, start: r.start, end: lunch.start },
        { weekday, start: lunch.end, end: r.end },
      ];
    }
    return [{ weekday, start: r.start, end: r.end }];
  });
}

const DEFAULT_ROWS: DayRow[] = DAYS.map((_, i) => ({ on: i < 6, start: "09:00", end: "19:00" }));

export function TeamSheet({
  branchId,
  staff,
  services,
  startWith,
  onClose,
  onCreated,
}: {
  branchId: string;
  staff: Staff[];
  services: Service[];
  /** "new" abre directo el formulario de alta; un id abre ese estilista. */
  startWith?: "new" | string;
  onClose: () => void;
  onCreated?: (id: string) => void;
}) {
  const [editing, setEditing] = useState<"new" | string | null>(startWith ?? null);
  const current = editing && editing !== "new" ? staff.find((s) => s.id === editing) : undefined;

  if (editing) {
    return (
      <StaffEditor
        key={editing}
        branchId={branchId}
        staff={current}
        services={services}
        onBack={() => (startWith ? onClose() : setEditing(null))}
        onSaved={(id, created) => {
          if (created) onCreated?.(id);
          if (startWith) onClose();
          else setEditing(null);
        }}
      />
    );
  }

  return (
    <Sheet title="Equipo" onClose={onClose}>
      <ul className="mb-5 grid gap-2">
        {staff.map((s) => (
          <li key={s.id}>
            <button
              className="flex w-full items-center gap-3 rounded-2xl border border-line bg-card px-4 py-3 text-left hover:border-plum-500"
              onClick={() => setEditing(s.id)}
            >
              <span className="size-3 rounded-full" style={{ background: s.color }} />
              <span className="flex-1">
                <span className={`font-medium ${s.active ? "" : "text-muted line-through"}`}>{s.displayName}</span>
                <span className="block text-sm text-muted">
                  {s.active ? `${s.serviceIds.length} servicios · ${workDays(s.weekly)}` : "Ya no trabaja aquí"}
                </span>
              </span>
              <span className="text-sm text-plum-700">Editar</span>
            </button>
          </li>
        ))}
      </ul>
      <Button className="w-full" onClick={() => setEditing("new")}>
        + Agregar estilista
      </Button>
    </Sheet>
  );
}

function workDays(weekly: Tramo[]): string {
  const days = [...new Set(weekly.map((w) => w.weekday))].sort();
  if (!days.length) return "sin horario";
  return days.map((d) => DAYS[d - 1]!.slice(0, 3)).join(" ");
}

function StaffEditor({
  branchId,
  staff,
  services,
  onBack,
  onSaved,
}: {
  branchId: string;
  staff?: Staff;
  services: Service[];
  onBack: () => void;
  onSaved: (id: string, created: boolean) => void;
}) {
  const qc = useQueryClient();
  const initial = staff ? toRows(staff.weekly) : { rows: DEFAULT_ROWS, lunch: null };
  const [name, setName] = useState(staff?.displayName ?? "");
  const [color, setColor] = useState(staff?.color ?? COLORS[1]!);
  const [serviceIds, setServiceIds] = useState<string[]>(staff?.serviceIds ?? services.map((s) => s.id));
  const [rows, setRows] = useState<DayRow[]>(initial.rows);
  const [hasLunch, setHasLunch] = useState(Boolean(initial.lunch));
  const [lunch, setLunch] = useState(initial.lunch ?? { start: "13:00", end: "14:00" });

  const save = useMutation({
    mutationFn: async () => {
      const weekly = toWeekly(rows, hasLunch ? lunch : null);
      if (!staff) {
        const r = await api<{ id: string }>("/v1/staff", { body: { branchId, displayName: name, color, serviceIds, weekly } });
        return { id: r.id, created: true };
      }
      await api(`/v1/staff/${staff.id}`, { method: "PATCH", body: { displayName: name, color } });
      await api(`/v1/staff/${staff.id}/services`, { method: "PUT", body: { serviceIds } });
      await api(`/v1/staff/${staff.id}/schedule`, { method: "PUT", body: { weekly } });
      return { id: staff.id, created: false };
    },
    onSuccess: ({ id, created }) => {
      void qc.invalidateQueries({ queryKey: ["staff"] });
      void qc.invalidateQueries({ queryKey: ["availability"] });
      onSaved(id, created);
    },
  });

  const toggleActive = useMutation({
    mutationFn: () => api(`/v1/staff/${staff!.id}`, { method: "PATCH", body: { active: !staff!.active } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["staff"] });
      onSaved(staff!.id, false);
    },
  });

  const setRow = (i: number, patch: Partial<DayRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const invalidDay = rows.find((r) => r.on && r.start >= r.end);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <Sheet title={staff ? `Editar a ${staff.displayName}` : "Nuevo estilista"} onClose={onBack}>
      <form onSubmit={onSubmit} className="grid gap-5">
        <Field label="Nombre" value={name} onChange={(e) => setName(e.target.value)} required maxLength={40} placeholder="Kevin" autoFocus={!staff} />

        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">Color en la agenda</legend>
          <div className="flex flex-wrap gap-2">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Color ${c}`}
                aria-pressed={c === color}
                onClick={() => setColor(c)}
                className={`size-9 rounded-full border-2 ${c === color ? "border-ink" : "border-transparent"}`}
                style={{ background: c }}
              />
            ))}
          </div>
        </fieldset>

        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">Servicios que hace</legend>
          <div className="flex flex-wrap gap-2">
            {services.map((s) => (
              <Chip
                key={s.id}
                active={serviceIds.includes(s.id)}
                onClick={() => setServiceIds(serviceIds.includes(s.id) ? serviceIds.filter((x) => x !== s.id) : [...serviceIds, s.id])}
              >
                {s.name}
              </Chip>
            ))}
          </div>
        </fieldset>

        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">Horario</legend>
          {rows.map((r, i) => (
            <div key={DAYS[i]} className="grid grid-cols-[7.5rem_1fr_1fr] items-center gap-2">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={r.on} onChange={(e) => setRow(i, { on: e.target.checked })} className="size-4 accent-plum-700" />
                {DAYS[i]}
              </label>
              {r.on ? (
                <>
                  <input aria-label={`Entrada ${DAYS[i]}`} type="time" step={900} value={r.start} onChange={(e) => setRow(i, { start: e.target.value })} className="tabular min-h-10 min-w-0 rounded-xl border border-line bg-card px-2" />
                  <input aria-label={`Salida ${DAYS[i]}`} type="time" step={900} value={r.end} onChange={(e) => setRow(i, { end: e.target.value })} className="tabular min-h-10 min-w-0 rounded-xl border border-line bg-card px-2" />
                </>
              ) : (
                <span className="col-span-2 text-sm text-muted">Descansa</span>
              )}
            </div>
          ))}
          <label className="mt-2 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={hasLunch} onChange={(e) => setHasLunch(e.target.checked)} className="size-4 accent-plum-700" />
            Refrigerio todos los días
          </label>
          {hasLunch && (
            <div className="grid grid-cols-[7.5rem_1fr_1fr] items-center gap-2">
              <span className="text-sm text-muted">De … a …</span>
              <input aria-label="Inicio del refrigerio" type="time" step={900} value={lunch.start} onChange={(e) => setLunch({ ...lunch, start: e.target.value })} className="tabular min-h-10 min-w-0 rounded-xl border border-line bg-card px-2" />
              <input aria-label="Fin del refrigerio" type="time" step={900} value={lunch.end} onChange={(e) => setLunch({ ...lunch, end: e.target.value })} className="tabular min-h-10 min-w-0 rounded-xl border border-line bg-card px-2" />
            </div>
          )}
        </fieldset>

        {invalidDay && <p className="text-sm text-rose-700">Revisa el horario: la salida debe ser después de la entrada.</p>}
        <ErrorBox error={save.error ?? toggleActive.error} />
        <Button type="submit" loading={save.isPending} disabled={!name.trim() || Boolean(invalidDay)}>
          {staff ? "Guardar cambios" : "Agregar estilista"}
        </Button>
        {staff && (
          <Button type="button" variant={staff.active ? "danger" : "secondary"} loading={toggleActive.isPending} onClick={() => toggleActive.mutate()}>
            {staff.active ? "Ya no trabaja aquí" : "Volver a activar"}
          </Button>
        )}
        {staff?.active && <p className="text-sm text-muted">Al desactivarlo deja de aparecer en la agenda y en las reservas. Su historial se conserva.</p>}
      </form>
    </Sheet>
  );
}
