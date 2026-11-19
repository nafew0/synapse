import { Tools } from 'librechat-data-provider';
import type { TAttachment } from 'librechat-data-provider';
import { pickDeliverables } from '../Deliverables';

const file = (filename: string, filepath: string, extra: object = {}) =>
  ({ file_id: `${filename}-${filepath}`, filename, filepath, ...extra }) as unknown as TAttachment;

describe('pickDeliverables', () => {
  it('keeps the last write of each file name', () => {
    const picked = pickDeliverables([
      file('Guide.docx', '/v1'),
      file('notes.txt', '/n1'),
      file('Guide.docx', '/v2'),
    ]);
    expect(picked.map((a) => (a as { filepath: string }).filepath)).toEqual(['/n1', '/v2']);
  });

  it('skips memory entries, background markers and entries without a file', () => {
    const picked = pickDeliverables([
      null,
      undefined,
      { [Tools.memory]: { key: 'k', value: 'v' } } as unknown as TAttachment,
      file('marker', '/m', { type: 'background_task_status' }),
      { file_id: 'pending', filename: 'x.docx' } as unknown as TAttachment,
      file('Deck.pptx', '/d'),
    ]);
    expect(picked).toHaveLength(1);
    expect((picked[0] as { filename: string }).filename).toBe('Deck.pptx');
  });
});
