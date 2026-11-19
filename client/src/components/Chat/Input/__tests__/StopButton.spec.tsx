import React from 'react';
import '@testing-library/jest-dom/extend-expect';
import { render, fireEvent, screen } from '@testing-library/react';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

import StopButton from '../StopButton';

describe('StopButton', () => {
  it('keeps one accessible name while the take-off plane and square are decorative', () => {
    render(<StopButton stop={jest.fn()} setShowStopButton={jest.fn()} />);
    const button = screen.getByRole('button', { name: 'com_nav_stop_generating' });
    expect(button).toHaveClass('lc-stop-button');
    const graphics = button.querySelectorAll('svg');
    expect(graphics).toHaveLength(2);
    graphics.forEach((svg) => expect(svg).toHaveAttribute('aria-hidden', 'true'));
  });

  it('stops the run and hides itself on click', () => {
    const stop = jest.fn();
    const setShowStopButton = jest.fn();
    render(<StopButton stop={stop} setShowStopButton={setShowStopButton} />);
    fireEvent.click(screen.getByTestId('stop-generation-button'));
    expect(setShowStopButton).toHaveBeenCalledWith(false);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
