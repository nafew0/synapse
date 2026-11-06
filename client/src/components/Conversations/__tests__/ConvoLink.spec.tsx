import React from 'react';
import '@testing-library/jest-dom/extend-expect';
import { render, screen } from '@testing-library/react';
import ConvoLink from '../ConvoLink';

const localize = (key: string) => key;

function renderLink(isGenerating?: boolean) {
  return render(
    <ConvoLink
      isActiveConvo={false}
      isPopoverActive={false}
      title="Budget notice to Word"
      onRename={jest.fn()}
      isSmallScreen={false}
      isGenerating={isGenerating}
      localize={localize}
    >
      <span />
    </ConvoLink>,
  );
}

describe('ConvoLink', () => {
  it('shimmers the title and announces generating while a reply streams', () => {
    renderLink(true);
    expect(screen.getByLabelText('Budget notice to Word')).toHaveClass('lc-title-generating');
    expect(screen.getByText('com_ui_generating')).toHaveClass('sr-only');
  });

  it('shows a plain title otherwise', () => {
    renderLink();
    expect(screen.getByLabelText('Budget notice to Word')).not.toHaveClass('lc-title-generating');
    expect(screen.queryByText('com_ui_generating')).not.toBeInTheDocument();
  });
});
