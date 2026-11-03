/** One element of Unstructured's Parse output. Coordinates and table HTML can be null on any element. */
export interface UnstructuredElement {
  type: string;
  element_id?: string;
  text?: string | null;
  metadata?: {
    page_number?: number | null;
    text_as_html?: string | null;
    image_base64?: string | null;
    category_depth?: number | null;
    parent_id?: string | null;
    coordinates?: {
      points?: number[][];
      system?: string;
      layout_width?: number;
      layout_height?: number;
    } | null;
    /** Set on pages Synapse read itself, so nothing mistakes them for OCR output. */
    source?: 'parser';
  };
}

export interface PartitionFile {
  buffer: Buffer;
  filename: string;
  type: string;
}

export interface UnstructuredClientOptions {
  apiUrl: string;
  apiKey: string;
  /** Parse profile. Only `best` reads Bangla and Sinhala well; `balanced` failed Sinhala in our test. */
  profile: string;
  /** Documents this process sends at once; the service publishes no limit of its own. */
  concurrency: number;
  timeoutMs?: number;
  pollMinMs?: number;
  pollMaxMs?: number;
}
