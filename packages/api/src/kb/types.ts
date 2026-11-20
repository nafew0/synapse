/** The parts of docling-core's `DoclingDocument` (schema 1.x) the knowledge base reads. */
export interface DoclingRef {
  $ref: string;
}

export interface DoclingProv {
  page_no: number;
}

export interface DoclingNode {
  self_ref: string;
  children?: DoclingRef[];
  label: string;
  name?: string;
  prov?: DoclingProv[];
  content_layer?: string;
}

export interface DoclingTextItem extends DoclingNode {
  text: string;
  level?: number;
}

export interface DoclingTableCell {
  text: string;
  column_header: boolean;
  row_header?: boolean;
  start_row_offset_idx: number;
  start_col_offset_idx: number;
}

export interface DoclingTableItem extends DoclingNode {
  data: {
    num_rows: number;
    num_cols: number;
    grid: DoclingTableCell[][];
  };
}

export interface DoclingDocument {
  schema_name: string;
  version: string;
  name: string;
  body: DoclingNode;
  groups: DoclingNode[];
  texts: DoclingTextItem[];
  tables: DoclingTableItem[];
  pictures: DoclingNode[];
}

export interface DoclingConvertResult {
  document: { json_content: DoclingDocument | null };
  status: string;
  errors?: { component_type?: string; module_name?: string; error_message?: string }[];
  processing_time?: number;
}

/** What the chunker reads, whichever parser produced it. */
export type KbElement =
  | { kind: 'heading'; text: string; level: number; page: number | null }
  | { kind: 'text'; text: string; page: number | null }
  | {
      kind: 'table';
      header: string[];
      rows: string[][];
      pageStart: number | null;
      pageEnd: number | null;
    };

export interface KbChunk {
  index: number;
  kind: 'text' | 'table';
  sectionPath: string;
  pageStart: number | null;
  pageEnd: number | null;
  text: string;
  /** Document title and section before the text: what gets embedded. */
  embedText: string;
}

export interface KbParsed {
  elements: KbElement[];
  pageCount: number;
}
