import React from 'react';
import '@testing-library/jest-dom/extend-expect';
import { render, fireEvent, screen } from '@testing-library/react';

const mockState = { show: true, isTemporary: true, toggle: jest.fn() };

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/hooks/Chat/useTemporaryChat', () => ({
  __esModule: true,
  default: () => mockState,
}));

import TemporaryChatStrip from '../TemporaryChatStrip';

describe('TemporaryChatStrip', () => {
  beforeEach(() => {
    mockState.show = true;
    mockState.isTemporary = true;
    mockState.toggle = jest.fn();
  });

  it('names the mode and turns it off from the strip before the chat starts', () => {
    render(<TemporaryChatStrip />);
    expect(screen.getByRole('status')).toHaveTextContent('com_ui_temporary_strip');
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_temporary_turn_off' }));
    expect(mockState.toggle).toHaveBeenCalledTimes(1);
  });

  it('keeps the label but drops the turn-off link once the chat has started', () => {
    mockState.show = false;
    render(<TemporaryChatStrip />);
    expect(screen.getByTestId('temporary-chat-strip')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders nothing outside temporary mode', () => {
    mockState.isTemporary = false;
    render(<TemporaryChatStrip />);
    expect(screen.queryByTestId('temporary-chat-strip')).not.toBeInTheDocument();
  });
});
