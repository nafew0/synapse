import React, { useEffect } from 'react';
import '@testing-library/jest-dom/extend-expect';
import { RecoilRoot, useRecoilValue } from 'recoil';
import { render, fireEvent, screen } from 'test/layout-test-utils';
import type { MutableSnapshot } from 'recoil';
import LanguageSTTDropdown from '../LanguageSTTDropdown';
import store from '~/store';

function LanguageObserver({ onChange }: { onChange: (value: string) => void }) {
  const languageSTT = useRecoilValue(store.languageSTT);
  useEffect(() => onChange(languageSTT), [languageSTT, onChange]);
  return null;
}

const renderDropdown = (languageSTT: string, onChange: (value: string) => void) =>
  render(
    <RecoilRoot
      initializeState={({ set }: MutableSnapshot) => {
        set(store.speechToText, true);
        set(store.languageSTT, languageSTT);
      }}
    >
      <LanguageSTTDropdown />
      <LanguageObserver onChange={onChange} />
    </RecoilRoot>,
  );

const choose = (label: string) => {
  fireEvent.click(screen.getByTestId('LanguageSTTDropdown'));
  fireEvent.click(screen.getByRole('option', { name: label }));
};

describe('LanguageSTTDropdown', () => {
  beforeEach(() => localStorage.clear());

  it('shows auto detect when no language is saved', () => {
    renderDropdown('', jest.fn());
    expect(screen.getByTestId('LanguageSTTDropdown')).toHaveTextContent('Auto detect');
  });

  it('saves a chosen language as its locale code', () => {
    const onChange = jest.fn();
    renderDropdown('', onChange);
    choose('Turkish');
    expect(onChange).toHaveBeenLastCalledWith('tr');
  });

  it('clears the saved language when auto detect is chosen', () => {
    const onChange = jest.fn();
    renderDropdown('en-US', onChange);
    expect(screen.getByTestId('LanguageSTTDropdown')).toHaveTextContent('English (US)');
    choose('Auto detect');
    expect(onChange).toHaveBeenLastCalledWith('');
  });
});
