import { herdGroupForms, pluralizeEs, singularizeEs } from './herd-grammar';

describe('herd-grammar', () => {
  it.each([
    ['endocrinólogo', 'endocrinólogos'],
    ['pediatra', 'pediatras'],
    ['investigador', 'investigadores'],
    ['residente', 'residentes'],
    ['médico general', 'médicos generales'],
    ['cirujano de tórax', 'cirujanos de tórax'],
    ['MÉDICO', 'MÉDICOS'],
  ])('%s ↔ %s', (singular, plural) => {
    expect(pluralizeEs(singular)).toBe(plural);
    expect(singularizeEs(plural)).toBe(singular);
  });

  it('casos de una sola dirección', () => {
    expect(pluralizeEs('sección')).toBe('secciones');
    expect(pluralizeEs('actriz')).toBe('actrices');
    expect(pluralizeEs('tórax')).toBe('tórax');
    expect(singularizeEs('secciones')).toBe('sección');
    expect(singularizeEs('actrices')).toBe('actriz');
  });

  it('deduce la forma que falta y usa la opción si no hay ninguna', () => {
    expect(
      herdGroupForms({ singular: 'endocrinólogo' }, 'Endocrinología'),
    ).toEqual({
      plural: 'endocrinólogos',
      singular: 'endocrinólogo',
    });
    expect(herdGroupForms({ label: 'pediatras' }, 'Pediatría')).toEqual({
      plural: 'pediatras',
      singular: 'pediatra',
    });
    expect(
      herdGroupForms({ label: 'gente', singular: 'persona' }, 'X'),
    ).toEqual({
      plural: 'gente',
      singular: 'persona',
    });
    expect(herdGroupForms(undefined, 'Pediatría')).toEqual({
      plural: 'Pediatría',
      singular: 'Pediatría',
    });
  });
});
