import type { InputFieldDef } from '../../common/types';

export type FieldValues = Record<string, string | number | boolean | undefined>;
export interface DomainOption {
  slug: string;
  name: string;
  isActive: boolean;
}

export function initialValues(fields: InputFieldDef[], from?: Record<string, unknown>): FieldValues {
  return Object.fromEntries(
    fields.map((f) => {
      const v = from?.[f.key] ?? f.default;
      return [f.key, f.type === 'boolean' ? Boolean(v) : v === undefined || v === null ? '' : (v as string | number)];
    }),
  );
}

/** Convert form strings to the types the server expects (empty optional fields are omitted). */
export function toPayload(fields: InputFieldDef[], values: FieldValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = values[f.key];
    if (f.type === 'boolean') out[f.key] = Boolean(v);
    else if (v === '' || v === undefined) continue;
    else if (f.type === 'number') out[f.key] = Number(v);
    else out[f.key] = typeof v === 'string' ? v.trim() : v;
  }
  return out;
}

export function FieldInput({
  field,
  value,
  error,
  domains,
  onChange,
  idPrefix,
}: {
  field: InputFieldDef;
  value: FieldValues[string];
  error?: string;
  domains?: DomainOption[] | null;
  onChange: (v: FieldValues[string]) => void;
  idPrefix: string;
}) {
  const id = `${idPrefix}-${field.key}`;
  const described = [field.help ? `${id}-help` : '', error ? `${id}-err` : ''].filter(Boolean).join(' ') || undefined;
  if (field.type === 'boolean') {
    return (
      <label className="toggle" htmlFor={id}>
        <input id={id} type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
        <span>
          {field.label}
          {field.help && (
            <span className="help" style={{ display: 'block', fontSize: 12, color: 'var(--ink-subtle)' }}>
              {field.help}
            </span>
          )}
        </span>
      </label>
    );
  }
  const common = { id, className: 'input', 'aria-describedby': described, 'aria-invalid': Boolean(error) || undefined, required: field.required };
  let control;
  if (field.type === 'textarea') {
    control = <textarea {...common} rows={3} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} placeholder={field.placeholder} />;
  } else if (field.type === 'domain' || field.type === 'select') {
    const options = field.type === 'domain' ? (domains ?? []).map((d) => ({ value: d.slug, label: `${d.name}${d.isActive ? '' : ' (closed)'}` })) : (field.options ?? []);
    control = (
      <select {...common} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
        <option value="">{field.type === 'domain' && domains === null ? 'Loading domains…' : field.required ? 'Select…' : 'Any'}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  } else {
    control = (
      <input
        {...common}
        type={field.type === 'number' ? 'number' : 'text'}
        min={field.min}
        max={field.max}
        step={field.step}
        value={String(value ?? '')}
        placeholder={field.placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <div className="field">
      <label htmlFor={id}>
        {field.label}
        {field.required && <span className="req"> *</span>}
      </label>
      {control}
      {field.help && (
        <span id={`${id}-help`} className="help">
          {field.help}
        </span>
      )}
      {error && (
        <span id={`${id}-err`} className="err">
          {error}
        </span>
      )}
    </div>
  );
}

export function ParameterForm({
  fields,
  values,
  errors,
  domains,
  disabled,
  onChange,
}: {
  fields: InputFieldDef[];
  values: FieldValues;
  errors: Record<string, string>;
  domains: DomainOption[] | null;
  disabled?: boolean;
  onChange: (values: FieldValues) => void;
}) {
  return (
    <fieldset className="form" disabled={disabled} style={{ border: 'none', margin: 0, padding: 0 }}>
      <legend className="sr-only">Workflow parameters</legend>
      {fields.map((f) => (
        <FieldInput key={f.key} idPrefix="param" field={f} value={values[f.key]} error={errors[f.key]} domains={domains} onChange={(v) => onChange({ ...values, [f.key]: v })} />
      ))}
    </fieldset>
  );
}
