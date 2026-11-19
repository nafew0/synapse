import { ContentTypes } from 'librechat-data-provider';
import type { TMessageContentParts } from 'librechat-data-provider';
import { hideWorkNotes } from '../workNotes';

const text = (value: string) => ({ type: ContentTypes.TEXT, text: value }) as TMessageContentParts;
const tool = (name: string) =>
  ({
    type: ContentTypes.TOOL_CALL,
    [ContentTypes.TOOL_CALL]: { id: name, name, args: '', type: 'tool_call' },
  }) as unknown as TMessageContentParts;
const shown = (parts: Array<TMessageContentParts | undefined> | undefined) =>
  (parts ?? []).flatMap((part) =>
    part?.type === ContentTypes.TEXT && part.text ? [part.text as string] : [],
  );

describe('hideWorkNotes', () => {
  it('hides notes before a tool call and keeps the final reply', () => {
    const content = [
      text('The gate failed'),
      tool('bash_tool'),
      text('note'),
      tool('skill'),
      text('Done'),
    ];
    expect(shown(hideWorkNotes(content, false))).toEqual(['Done']);
  });

  it('leaves the stored parts untouched', () => {
    const content = [text('note'), tool('bash_tool'), text('Done')];
    hideWorkNotes(content, false);
    expect(content[0]).toEqual(text('note'));
  });

  it('keeps the text that introduces a question', () => {
    const content = [text('Which one?'), tool('ask_user_question')];
    expect(shown(hideWorkNotes(content, false))).toEqual(['Which one?']);
  });

  it('keeps the last note when a finished run has no final reply', () => {
    const content = [text('first'), tool('bash_tool'), text('stopped here'), tool('bash_tool')];
    expect(shown(hideWorkNotes(content, false))).toEqual(['stopped here']);
  });

  it('hides that note while the run is still streaming', () => {
    const content = [text('working'), tool('bash_tool')];
    expect(shown(hideWorkNotes(content, true))).toEqual([]);
  });

  it('returns the same array when nothing is hidden', () => {
    const content = [tool('bash_tool'), text('Done')];
    expect(hideWorkNotes(content, false)).toBe(content);
  });

  it('copes with holes left by streaming', () => {
    const content: Array<TMessageContentParts | undefined> = [
      text('note'),
      undefined,
      tool('skill'),
      text('Done'),
    ];
    expect(shown(hideWorkNotes(content, false))).toEqual(['Done']);
  });
});
