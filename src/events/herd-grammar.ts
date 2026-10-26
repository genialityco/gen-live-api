/**
 * Singular/plural aproximado en español para los nombres de grupo de manada
 * ("endocrinólogo" ↔ "endocrinólogos", "médico general" ↔ "médicos generales").
 * El admin escribe una forma y la otra se deduce; si la deducción falla puede
 * escribir ambas.
 * IMPORTANTE: el frontend (src/api/herd.ts) replica estas reglas para las
 * sugerencias del admin; si cambias una, cambia la otra.
 */

// Solo se flexionan las palabras antes de la primera preposición:
// "cirujano de tórax" → "cirujanos de tórax"
const STOP_WORDS = new Set([
  'de',
  'del',
  'en',
  'con',
  'para',
  'por',
  'y',
  'e',
  'o',
  'u',
  'a',
  'al',
]);

const STRIP_ACCENT: Record<string, string> = {
  á: 'a',
  é: 'e',
  í: 'i',
  ó: 'o',
  ú: 'u',
};

function matchCase(word: string, suffix: string) {
  return word.length > 1 && word === word.toUpperCase()
    ? suffix.toUpperCase()
    : suffix;
}

function pluralizeWord(word: string): string {
  const w = word.toLowerCase();
  const last = w.slice(-1);
  if (!/[a-záéíóúüñ]/.test(last)) return word;
  if (/[aeiouáéó]/.test(last)) return word + matchCase(word, 's');
  if (/[íú]/.test(last)) return word + matchCase(word, 'es');
  if (last === 'z') return word.slice(0, -1) + matchCase(word, 'ces');
  // Aguda con tilde en n/s: "sección" → "secciones", "francés" → "franceses"
  const accented = /([áéíóú])([ns])$/.exec(w);
  if (accented) {
    const base = word.slice(0, -2) + STRIP_ACCENT[accented[1]] + word.slice(-1);
    return base + matchCase(word, 'es');
  }
  // Llanas terminadas en s/x no cambian: "tórax", "análisis"
  if (last === 's' || last === 'x') return word;
  return word + matchCase(word, 'es');
}

function singularizeWord(word: string): string {
  const w = word.toLowerCase();
  if (!w.endsWith('s') || w.length < 3) return word;
  if (w.endsWith('ces')) return word.slice(0, -3) + matchCase(word, 'z');
  if (w.endsWith('iones')) return word.slice(0, -5) + matchCase(word, 'ión');
  // "investigadores" → "investigador", "generales" → "general"
  if (/[lrndjy]es$/.test(w)) return word.slice(0, -2);
  if (/[aeiouáéíóú]s$/.test(w)) return word.slice(0, -1);
  return word;
}

function inflect(phrase: string, fn: (w: string) => string) {
  let stopped = false;
  return phrase
    .split(/(\s+)/)
    .map((part) => {
      if (stopped || !part.trim()) return part;
      if (STOP_WORDS.has(part.toLowerCase())) {
        stopped = true;
        return part;
      }
      return fn(part);
    })
    .join('');
}

export const pluralizeEs = (phrase: string) =>
  inflect(phrase.trim(), pluralizeWord);
export const singularizeEs = (phrase: string) =>
  inflect(phrase.trim(), singularizeWord);

/**
 * Formas finales de un grupo a partir de lo que escribió el admin. Sin nada
 * escrito se usa la etiqueta de la opción del formulario en ambas.
 */
export function herdGroupForms(
  custom: { label?: string; singular?: string } | undefined,
  fallback: string,
): { plural: string; singular: string } {
  const plural = custom?.label?.trim() ?? '';
  const singular = custom?.singular?.trim() ?? '';
  return {
    plural: plural || (singular ? pluralizeEs(singular) : fallback),
    singular: singular || (plural ? singularizeEs(plural) : fallback),
  };
}
