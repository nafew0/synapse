import { dedupeAttachments } from './attachments';

describe('dedupeAttachments', () => {
  /**
   * The failure this exists for: the pptx agent rebuilds a deck inside its own
   * visual-QA loop, so one artifact resolved three promises and the message kept
   * all three. The chat showed `network_security_basics.pptx` three times over,
   * next to one montage — one file, presented as three.
   */
  it('keeps one entry for a file written several times in a turn', () => {
    const deck = { file_id: 'deck-1', filename: 'deck.pptx' };
    const kept = dedupeAttachments([
      { ...deck, bytes: 100 },
      { ...deck, bytes: 150 },
      { ...deck, bytes: 162883 },
      { file_id: 'img-1', filename: 'montage.jpg' },
    ]);

    expect(kept).toHaveLength(2);
    expect(kept.map((a) => a.file_id)).toEqual(['deck-1', 'img-1']);
  });

  it('keeps the newest metadata at the position the artifact first appeared', () => {
    /** The last write carries the final size and lifecycle status; the first
     *  emission is where the user watched it appear. */
    const kept = dedupeAttachments([
      { file_id: 'a', filename: 'deck.pptx', bytes: 100, status: 'pending' },
      { file_id: 'b', filename: 'notes.txt', bytes: 10 },
      { file_id: 'a', filename: 'deck.pptx', bytes: 900, status: 'ready' },
    ]);

    expect(kept.map((a) => a.file_id)).toEqual(['a', 'b']);
    expect(kept[0]).toMatchObject({ bytes: 900, status: 'ready' });
  });

  it('separates distinct artifacts that share a filename', () => {
    const kept = dedupeAttachments([
      { file_id: 'one', filename: 'chart.png' },
      { file_id: 'two', filename: 'chart.png' },
    ]);

    expect(kept).toHaveLength(2);
  });

  it('falls back to filepath, then filename, when there is no file id', () => {
    const kept = dedupeAttachments([
      { filepath: '/out/a.png', filename: 'a.png' },
      { filepath: '/out/a.png', filename: 'a.png' },
      { filename: 'b.png' },
      { filename: 'b.png' },
    ]);

    expect(kept.map((a) => a.filename)).toEqual(['a.png', 'b.png']);
  });

  it('never collapses artifacts it cannot identify', () => {
    const kept = dedupeAttachments([{ file_id: null }, { file_id: null }, { filename: '' }]);

    expect(kept).toHaveLength(3);
  });

  it('returns a list of one untouched', () => {
    const only = [{ file_id: 'a' }];

    expect(dedupeAttachments(only)).toBe(only);
  });
});
