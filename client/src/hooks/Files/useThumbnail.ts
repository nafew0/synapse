import { useEffect, useState } from 'react';
import type { ExtendedFile } from '~/common';
import { findThumbnail, getThumbnail, rememberThumbnail } from '~/utils/thumbnail';

/**
 * The first-page picture of an attachment, or null while it is drawn or when there is none. It is
 * drawn from the local `File` and remembered by id, so it outlives the swap to the server's record.
 */
export default function useThumbnail({
  file,
  file_id,
  temp_file_id,
}: Pick<ExtendedFile, 'file' | 'file_id' | 'temp_file_id'>): string | null {
  const known = findThumbnail(file_id, temp_file_id);
  const [drawn, setDrawn] = useState<string | null>(null);

  useEffect(() => {
    if (known != null || !(file instanceof File)) {
      return;
    }
    let current = true;
    getThumbnail(file).then((url) => {
      if (url) {
        rememberThumbnail(file_id, url);
      }
      if (current) {
        setDrawn(url);
      }
    });
    return () => {
      current = false;
    };
  }, [file, file_id, known]);

  return known ?? drawn;
}
