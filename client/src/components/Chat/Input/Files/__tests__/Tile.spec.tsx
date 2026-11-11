import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ExtendedFile } from '~/common';
import Tile, { getExtension } from '../Tile';

jest.mock('~/utils/thumbnail', () => ({
  ...jest.requireActual('~/utils/thumbnail'),
  getThumbnail: jest.fn(async (file: File) =>
    file.name.endsWith('.pdf') ? 'data:image/jpeg;base64,cGFnZQ==' : null,
  ),
}));

const pdf = (overrides: Partial<ExtendedFile> = {}): ExtendedFile => ({
  file_id: 'pdf-1',
  filename: 'Annual report.pdf',
  type: 'application/pdf',
  size: 1024,
  progress: 1,
  ...overrides,
});

describe('file Tile', () => {
  test('names the file and its status for assistive tech, and shows the extension', () => {
    render(<Tile file={pdf()} onDelete={jest.fn()} />);

    const tile = screen.getByRole('group');
    expect(tile.getAttribute('aria-label')).toMatch(/^Annual report\.pdf · /);
    expect(screen.getByText('PDF')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  test('shows the scan overlay with the upload percentage in place of the extension', () => {
    render(<Tile file={pdf({ progress: 0.4, uploadProgress: 0.37 })} onDelete={jest.fn()} />);

    expect(screen.getByRole('progressbar')).toHaveTextContent('37%');
    expect(screen.queryByText('PDF')).not.toBeInTheDocument();
    expect(screen.getByRole('group').getAttribute('aria-label')).toContain('Uploading');
  });

  test('shows the first page in place of the file-type icon once it is drawn', async () => {
    const { container } = render(
      <Tile
        file={pdf({ file: new File(['%PDF'], 'Annual report.pdf', { type: 'application/pdf' }) })}
        onDelete={jest.fn()}
      />,
    );

    await waitFor(() =>
      expect(container.querySelector('img')).toHaveAttribute(
        'src',
        'data:image/jpeg;base64,cGFnZQ==',
      ),
    );
    expect(container.querySelector('svg rect')).not.toBeInTheDocument();
    expect(screen.getByText('PDF')).toHaveClass('bg-black/60');
  });

  test('keeps the page once the upload swaps in the server record, which has no local file', async () => {
    const local = pdf({
      file_id: 'temp-7',
      file: new File(['%PDF'], 'Annual report.pdf', { type: 'application/pdf' }),
    });
    const { container, rerender } = render(<Tile file={local} onDelete={jest.fn()} />);
    await waitFor(() => expect(container.querySelector('img')).toBeInTheDocument());

    rerender(
      <Tile file={pdf({ file_id: 'stored-7', temp_file_id: 'temp-7' })} onDelete={jest.fn()} />,
    );

    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      'data:image/jpeg;base64,cGFnZQ==',
    );
  });

  test('keeps the file-type icon when the file has no page picture', async () => {
    const { container } = render(
      <Tile
        file={pdf({
          file_id: 'csv-1',
          filename: 'data.csv',
          type: 'text/csv',
          file: new File(['a'], 'data.csv'),
        })}
        onDelete={jest.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText('CSV')).toBeInTheDocument());
    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(container.querySelector('svg rect')).toBeInTheDocument();
  });

  test('removes the file from its remove button', () => {
    const onDelete = jest.fn();
    render(<Tile file={pdf()} onDelete={onDelete} />);

    fireEvent.click(screen.getByRole('button', { name: /remove/i }));

    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['report.final.PDF', 'PDF'],
    ['notes.docx', 'DOCX'],
    ['archive.backup2026', ''],
    ['README', ''],
    ['.env', ''],
    [undefined, ''],
  ])('extension of %s is "%s"', (filename, expected) => {
    expect(getExtension(filename)).toBe(expected);
  });
});
