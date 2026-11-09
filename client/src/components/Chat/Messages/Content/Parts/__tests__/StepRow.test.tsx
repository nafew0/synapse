import React from 'react';
import { render, screen } from '@testing-library/react';
import StepRow, { DenseStepsContext } from '../StepRow';

describe('StepRow', () => {
  it('keeps the standalone spacing outside an activity block', () => {
    render(<StepRow data-testid="row" />);
    expect(screen.getByTestId('row')).toHaveClass('my-1.5');
  });

  it('tightens inside an activity block', () => {
    render(
      <DenseStepsContext.Provider value={true}>
        <StepRow data-testid="row" />
      </DenseStepsContext.Provider>,
    );
    expect(screen.getByTestId('row')).toHaveClass('my-0.5');
    expect(screen.getByTestId('row')).not.toHaveClass('my-1.5');
  });
});
