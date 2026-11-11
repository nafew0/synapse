import React from 'react';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import ImagePreview from '../ImagePreview';
import Scan, { getClarity } from '../Scan';

const blurOf = () => screen.getByTestId('scan-blur').style.backdropFilter;

describe('Scan upload overlay', () => {
  test('shows the share of bytes sent while the file uploads', () => {
    render(<Scan progress={0.3} uploadProgress={0.42} stage="uploading" />);

    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '42');
    expect(bar).toHaveTextContent('42%');
    expect(screen.getByTestId('scan-beam')).toHaveClass('animate-upload-scan');
  });

  test('drops the percentage once the server is preparing the file, but keeps scanning', () => {
    render(<Scan progress={0.9} uploadProgress={1} stage="indexing" />);

    const bar = screen.getByRole('progressbar');
    expect(bar).not.toHaveAttribute('aria-valuenow');
    expect(bar).not.toHaveTextContent('%');
    expect(screen.getByTestId('scan-beam')).toBeInTheDocument();
  });

  test('sharpens as the upload and each server stage move on', () => {
    const { rerender } = render(<Scan progress={0.1} uploadProgress={0} />);
    expect(blurOf()).toBe('blur(6.0px) saturate(0.40)');

    rerender(<Scan progress={0.5} uploadProgress={1} stage="uploading" />);
    expect(blurOf()).toBe('blur(3.0px) saturate(0.70)');

    rerender(<Scan progress={0.8} uploadProgress={1} stage="indexing" />);
    expect(blurOf()).toBe('blur(0.9px) saturate(0.91)');
  });

  test('fades out, unsharpened and hidden from assistive tech, when the upload finishes', () => {
    const { container, rerender } = render(<Scan progress={0.5} uploadProgress={0.5} />);

    rerender(<Scan progress={1} uploadProgress={1} stage="ready" />);

    const overlay = container.firstElementChild as HTMLElement;
    expect(overlay).toHaveClass('opacity-0');
    expect(overlay).toHaveAttribute('aria-hidden', 'true');
    expect(blurOf()).toBe('blur(0.0px) saturate(1.00)');
    expect(screen.queryByTestId('scan-beam')).not.toBeInTheDocument();
  });

  test('never appears on a file that was already uploaded', () => {
    const { container } = render(<Scan progress={1} />);

    expect(container).toBeEmptyDOMElement();
  });

  test('never appears on a stored file that carries no progress', () => {
    const { container } = render(<Scan />);

    expect(container).toBeEmptyDOMElement();
  });

  test('clarity tracks the upload for its first half and the server stages after that', () => {
    expect(getClarity()).toBe(0);
    expect(getClarity(0.5)).toBe(0.25);
    expect(getClarity(1, 'reading')).toBeGreaterThan(getClarity(1));
    expect(getClarity(1, 'ready')).toBe(1);
  });
});

describe('ImagePreview while uploading', () => {
  test('puts the scan overlay with the upload percentage on the image tile', () => {
    render(<ImagePreview url="/img.png" progress={0.6} uploadProgress={0.75} />);

    expect(screen.getByRole('progressbar')).toHaveTextContent('75%');
  });
});
