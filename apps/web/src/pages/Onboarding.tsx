import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api, setActiveTenant } from "../lib/api";
import { Button, Chip, ErrorBox, Field } from "../components/ui";

const TEMPLATES = [
  { id: "barberia", label: "Barbería" },
  { id: "peluqueria", label: "Peluquería" },
  { id: "unas", label: "Uñas" },
  { id: "vacio", label: "Lo armo yo" },
] as const;

const slugify = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);

export function OnboardingPage({ userName }: { userName: string }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [template, setTemplate] = useState<(typeof TEMPLATES)[number]["id"]>("barberia");

  const create = useMutation({
    mutationFn: () =>
      api<{ tenantId: string }>("/v1/onboarding", { body: { salonName: name, slug, template }, tenant: false }),
    onSuccess: (r) => {
      setActiveTenant(r.tenantId);
      void qc.invalidateQueries();
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  return (
    <main className="mx-auto grid min-h-full max-w-md content-center gap-8 px-4 py-10">
      <div className="grid gap-2">
        <p className="text-sm font-medium tracking-wide text-plum-700 uppercase">Paso 1 de 1</p>
        <h1 className="font-display text-3xl font-bold text-balance">{userName.split(" ")[0]}, ¿cómo se llama tu salón?</h1>
        <p className="text-muted">Te dejamos los servicios y el horario listos. Todo se puede cambiar después.</p>
      </div>
      <form onSubmit={onSubmit} className="grid gap-5">
        <Field
          label="Nombre del salón"
          value={name}
          required
          minLength={2}
          onChange={(e) => {
            setName(e.target.value);
            if (!slugTouched) setSlug(slugify(e.target.value));
          }}
          placeholder="Barbería Don Lucho"
        />
        <Field
          label="Tu enlace de reservas"
          value={slug}
          required
          pattern="[a-z0-9][a-z0-9-]{1,46}[a-z0-9]"
          onChange={(e) => {
            setSlugTouched(true);
            setSlug(slugify(e.target.value));
          }}
          hint={`${location.host}/reservar/${slug || "tu-salon"} · lo compartes en Instagram y WhatsApp`}
        />
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">¿Qué tipo de negocio es?</legend>
          <div className="flex flex-wrap gap-2">
            {TEMPLATES.map((t) => (
              <Chip key={t.id} active={template === t.id} onClick={() => setTemplate(t.id)}>
                {t.label}
              </Chip>
            ))}
          </div>
        </fieldset>
        <ErrorBox error={create.error} />
        <Button type="submit" loading={create.isPending}>
          Crear mi salón
        </Button>
      </form>
    </main>
  );
}
