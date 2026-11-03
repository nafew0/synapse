import React from 'react';
import { RecoilRoot } from 'recoil';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { TAttachment } from 'librechat-data-provider';
import { DeliveryProvider } from '../delivery';
import Attachment from '../Attachment';

let mockPreviewStatus: 'ready' | 'pending' = 'ready';
const mockHandleDownload = jest.fn();

jest.mock('~/hooks', () => ({
  useLocalize:
    () =>
    (key: string): string =>
      key,
  useAttachmentPreviewSync: () => ({
    status: mockPreviewStatus,
    previewError: undefined,
    isPolling: false,
  }),
  useExpandCollapse: () => ({ style: {}, ref: { current: null } }),
}));

jest.mock('../LogLink', () => ({
  useAttachmentLink: () => ({ handleDownload: mockHandleDownload }),
}));

jest.mock('~/components/Chat/Input/Files/FileContainer', () => ({
  __esModule: true,
  default: ({
    displayName,
    subtitle,
    onClick,
  }: {
    displayName?: string;
    subtitle?: ReactNode;
    onClick?: () => void;
  }) => (
    <button type="button" data-testid="file-container" onClick={onClick}>
      {displayName}
      {subtitle}
    </button>
  ),
}));

jest.mock('~/components/Chat/Input/Files/FilePreview', () => ({
  __esModule: true,
  default: () => <div data-testid="file-preview" />,
}));

jest.mock('~/utils', () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
  getFileType: () => ({ paths: [], color: '', title: 'Artifact' }),
  logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  isArtifactRoute: () => false,
}));

const file = (overrides: Partial<TAttachment>): TAttachment =>
  ({
    file_id: 'file-1',
    filepath: '/files/file-1',
    type: 'application/octet-stream',
    toolCallId: 'call-1',
    ...overrides,
  }) as TAttachment;

const docx = file({ filename: 'notice.docx', text: 'নোটিশ' } as Partial<TAttachment>);
const archive = file({ filename: 'scans.zip' });

const renderDelivered = (attachment: TAttachment, ready: boolean) => {
  const ui = (value: boolean) => (
    <RecoilRoot>
      <DeliveryProvider value={value}>
        <Attachment attachment={attachment} />
      </DeliveryProvider>
    </RecoilRoot>
  );
  const view = render(ui(ready));
  return { ...view, finish: () => view.rerender(ui(true)) };
};

const downloadButton = (name: string) =>
  screen.queryByRole('button', { name: new RegExp(`com_ui_download ${name.replace('.', '\\.')}`) });

describe('delivered file downloads', () => {
  beforeEach(() => {
    mockPreviewStatus = 'ready';
    mockHandleDownload.mockClear();
  });

  it('shows a Word card without its download while the reply streams', () => {
    renderDelivered(docx, false);

    expect(screen.getByText('notice.docx')).toBeInTheDocument();
    expect(downloadButton('notice.docx')).toBeNull();
    expect(screen.getByRole('status', { name: 'com_ui_download_after_reply' })).toBeInTheDocument();
  });

  it('offers the download once the reply has finished', () => {
    const { finish } = renderDelivered(docx, false);
    finish();

    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(downloadButton('notice.docx') as HTMLElement);
    expect(mockHandleDownload).toHaveBeenCalledTimes(1);
  });

  it('keeps the download off a preview that is still rendering until the reply ends', () => {
    mockPreviewStatus = 'pending';
    const { finish } = renderDelivered(file({ filename: 'report.docx', status: 'pending' }), false);

    expect(screen.getByText('report.docx')).toBeInTheDocument();
    expect(downloadButton('report.docx')).toBeNull();

    finish();
    expect(downloadButton('report.docx')).toBeInTheDocument();
  });

  it('makes a plain file chip download only after the reply ends', () => {
    const { finish } = renderDelivered(archive, false);

    const chip = screen.getByTestId('file-container');
    expect(chip).toHaveTextContent('com_ui_download_after_reply');
    fireEvent.click(chip);
    expect(mockHandleDownload).not.toHaveBeenCalled();

    finish();
    expect(screen.getByTestId('file-container')).not.toHaveTextContent(
      'com_ui_download_after_reply',
    );
    fireEvent.click(screen.getByTestId('file-container'));
    expect(mockHandleDownload).toHaveBeenCalledTimes(1);
  });

  it('downloads straight away outside a running reply', () => {
    render(
      <RecoilRoot>
        <Attachment attachment={docx} />
      </RecoilRoot>,
    );

    expect(downloadButton('notice.docx')).toBeInTheDocument();
  });
});
