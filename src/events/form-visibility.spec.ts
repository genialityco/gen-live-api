import { isFieldEffectivelyVisible, isConditional } from './form-visibility';

// Especialidad solo para quien eligió "Médico especialista" en Profesión
const profesion = { id: 'profesion' };
const especialidad = {
  id: 'especialidad',
  conditionalLogic: [
    {
      action: 'show' as const,
      logic: 'and' as const,
      conditions: [
        {
          field: 'profesion',
          operator: 'equals' as const,
          value: 'Médico especialista',
        },
      ],
    },
  ],
};
const fields = [profesion, especialidad];

describe('isFieldEffectivelyVisible', () => {
  it('muestra el campo cuando se cumple la preselección', () => {
    expect(
      isFieldEffectivelyVisible(
        especialidad,
        { profesion: 'Médico especialista' },
        fields,
      ),
    ).toBe(true);
  });

  it('lo oculta con otra preselección o sin ella', () => {
    expect(
      isFieldEffectivelyVisible(
        especialidad,
        { profesion: 'Enfermería' },
        fields,
      ),
    ).toBe(false);
    expect(isFieldEffectivelyVisible(especialidad, {}, fields)).toBe(false);
  });

  it('dependsOn: oculto si el padre está vacío', () => {
    const hijo = { id: 'subespecialidad', dependsOn: 'especialidad' };
    const all = [...fields, hijo];
    expect(
      isFieldEffectivelyVisible(
        hijo,
        { profesion: 'Médico especialista', especialidad: '' },
        all,
      ),
    ).toBe(false);
    expect(
      isFieldEffectivelyVisible(
        hijo,
        { profesion: 'Médico especialista', especialidad: 'Endocrinología' },
        all,
      ),
    ).toBe(true);
  });

  it('hidden siempre oculta y un campo sin condiciones siempre se ve', () => {
    expect(isFieldEffectivelyVisible({ id: 'x', hidden: true }, {}, [])).toBe(
      false,
    );
    expect(isFieldEffectivelyVisible(profesion, {}, fields)).toBe(true);
    expect(isConditional(especialidad)).toBe(true);
    expect(isConditional(profesion)).toBe(false);
  });
});
