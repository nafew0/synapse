import { withSecretFocus } from '../Mascot';
import type { UseFormRegisterReturn } from 'react-hook-form';
import type { FocusEvent } from 'react';
import type { MascotController } from '../Mascot';

const controller = (): MascotController => ({
  setSecretFocused: jest.fn(),
  setSubmitting: jest.fn(),
  noteKeystroke: jest.fn(),
  noteFailure: jest.fn(),
  noteSuccess: jest.fn(),
});

const field = (): UseFormRegisterReturn<'password'> => ({
  name: 'password',
  ref: jest.fn(),
  onChange: jest.fn(),
  onBlur: jest.fn().mockResolvedValue(true),
});

describe('withSecretFocus', () => {
  it('marks the secret focused on focus and released on blur', () => {
    const mascot = controller();
    const wrapped = withSecretFocus(field(), mascot);

    wrapped.onFocus();
    wrapped.onBlur({} as FocusEvent<HTMLInputElement>);

    expect(mascot.setSecretFocused).toHaveBeenNthCalledWith(1, true);
    expect(mascot.setSecretFocused).toHaveBeenNthCalledWith(2, false);
  });

  it("still runs react-hook-form's own onBlur", () => {
    const registered = field();
    const event = {} as FocusEvent<HTMLInputElement>;

    withSecretFocus(registered, controller()).onBlur(event);

    expect(registered.onBlur).toHaveBeenCalledWith(event);
  });

  it('keeps the rest of the registration intact', () => {
    const registered = field();
    const wrapped = withSecretFocus(registered, controller());

    expect(wrapped.name).toBe('password');
    expect(wrapped.ref).toBe(registered.ref);
    expect(wrapped.onChange).toBe(registered.onChange);
  });
});
