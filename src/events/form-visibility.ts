/**
 * Visibilidad condicional de los campos del formulario de registro.
 *
 * IMPORTANTE: es una copia de gen-live-web/src/utils/form-visibility.ts, que
 * decide qué campos se le muestran (y por tanto se le exigen) al asistente.
 * Si cambias uno, cambia el otro: el diagnóstico de grupos de manada debe
 * decidir igual que el formulario si un campo "no aplica" a una persona.
 */

type Values = Record<string, unknown>;

type Condition = {
  field: string;
  operator: 'equals' | 'notEquals' | 'contains' | 'notContains';
  value: unknown;
};

type Rule = {
  action: 'show' | 'hide';
  conditions?: Condition[];
  logic?: 'and' | 'or';
};

export type VisibilityField = {
  id: string;
  hidden?: boolean;
  dependsOn?: string;
  conditionalLogic?: Rule[] | null;
};

function evaluateCondition(c: Condition, values: Values): boolean {
  const v = values[c.field];
  switch (c.operator) {
    case 'equals':
      return v === c.value;
    case 'notEquals':
      return v !== c.value;
    case 'contains':
      return typeof v === 'string' ? v.includes(String(c.value)) : false;
    case 'notContains':
      return typeof v === 'string' ? !v.includes(String(c.value)) : true;
    default:
      return false;
  }
}

function evaluateRule(rule: Rule, values: Values): boolean {
  if (!rule.conditions?.length) return true;
  return rule.logic === 'and'
    ? rule.conditions.every((c) => evaluateCondition(c, values))
    : rule.conditions.some((c) => evaluateCondition(c, values));
}

/** hidden estático + conditionalLogic del propio campo */
export function shouldShowField(field: VisibilityField, values: Values) {
  if (field.hidden) return false;
  const logic = field.conditionalLogic;
  if (!logic?.length) return true;
  const show = logic.filter((r) => r.action === 'show');
  const hide = logic.filter((r) => r.action === 'hide');
  let visible = show.length ? show.some((r) => evaluateRule(r, values)) : true;
  if (hide.some((r) => evaluateRule(r, values))) visible = false;
  return visible;
}

/**
 * Visibilidad efectiva: la propia y la cadena `dependsOn` (no es visible si
 * su padre no lo es o está vacío)
 */
export function isFieldEffectivelyVisible(
  field: VisibilityField,
  values: Values,
  allFields: VisibilityField[],
  depth = 0,
): boolean {
  if (depth > 20) return false; // ciclo en dependsOn
  if (field.dependsOn) {
    const parent = allFields.find((f) => f.id === field.dependsOn);
    if (parent) {
      const pv = values[parent.id];
      if (
        !isFieldEffectivelyVisible(parent, values, allFields, depth + 1) ||
        pv === '' ||
        pv === null ||
        pv === undefined
      ) {
        return false;
      }
    }
  }
  return shouldShowField(field, values);
}

/** ¿El campo se muestra solo bajo alguna condición? */
export function isConditional(field: VisibilityField) {
  return !!field.dependsOn || !!field.conditionalLogic?.length;
}
