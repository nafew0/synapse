import { selectMemoriesForMessage, memoryTextForPrompt } from './select';

const memories = new Map([
  ['personal_info', "The user's name is Imtiaz. The user was born on 5 March 1995."],
  ['work_info', 'The user works in the IT department at BUET.'],
  ['context', 'The user is writing an MSc thesis on rice yield prediction.'],
  ['interests', 'The user enjoys photography.'],
  ['preferences', 'The user prefers short answers in Bangla.'],
]);

const select = (...messages: string[]) =>
  selectMemoriesForMessage({ valuesByKey: memories, messages });

describe('selectMemoriesForMessage', () => {
  it('always sends the core facts', () => {
    const { text, shown, total } = select('What is 17 times 23?');
    expect(text).toContain("The user's name is Imtiaz.");
    expect(text).toContain('born on 5 March 1995');
    expect(text).toContain('short answers in Bangla');
    expect(text).not.toContain('BUET');
    expect(text).not.toContain('thesis');
    expect(text).not.toContain('photography');
    expect(shown).toBe(3);
    expect(total).toBe(6);
  });

  it('adds a fact that shares a word with the message', () => {
    expect(select('Suggest a structure for my rice yield chapter').text).toContain('MSc thesis');
    expect(select('Any tips for photography at night?').text).toContain('photography');
  });

  it('adds a key the message points at by its cue words', () => {
    expect(select('Help me plan my research').text).toContain('MSc thesis');
    expect(select('Write an email to my department head').text).toContain('BUET');
  });

  it('understands Bangla cue words and inflected words', () => {
    expect(select('আমার গবেষণার জন্য একটি পরিকল্পনা দাও').text).toContain('MSc thesis');
    expect(select('আমার বিশ্ববিদ্যালয়ের ছুটির নোটিশ লিখে দাও').text).toContain('BUET');
  });

  it('sends everything when the user asks what is remembered', () => {
    expect(select('What do you know about me?').shown).toBe(6);
    expect(select('আমার সম্পর্কে কী জানো?').shown).toBe(6);
  });

  it('reads the earlier message too, so a follow-up keeps its topic', () => {
    expect(select('Help me with my thesis outline', 'Make it shorter').text).toContain(
      'MSc thesis',
    );
  });

  it('numbers the facts one per line', () => {
    expect(select('Hello').text.split('\n')[0]).toBe("1. The user's name is Imtiaz.");
  });

  it('returns nothing when nothing is saved', () => {
    expect(selectMemoriesForMessage({ valuesByKey: new Map(), messages: ['hi'] })).toEqual({
      text: '',
      shown: 0,
      total: 0,
    });
  });
});

describe('memoryTextForPrompt', () => {
  const formatted = { withKeys: 'keyed text', withoutKeys: 'all facts', valuesByKey: memories };

  it('sends only the selected facts and says the list is partial', () => {
    const result = memoryTextForPrompt({
      memories: formatted,
      keyed: false,
      recentMessages: ['What is 17 times 23?'],
    });
    expect(result.text).toContain('Imtiaz');
    expect(result.text).not.toContain('BUET');
    expect(result.partial).toBe(true);
    expect(result.hasSaved).toBe(true);
  });

  it('gives agents that manage memory the full keyed text', () => {
    expect(
      memoryTextForPrompt({ memories: formatted, keyed: true, recentMessages: ['hi'] }),
    ).toEqual({ text: 'keyed text', partial: false, hasSaved: true });
  });

  it('falls back to every fact without per-key values', () => {
    expect(
      memoryTextForPrompt({
        memories: { withoutKeys: 'all facts' },
        keyed: false,
        recentMessages: ['hi'],
      }),
    ).toEqual({ text: 'all facts', partial: false, hasSaved: true });
  });

  it('reports nothing saved without memories', () => {
    expect(memoryTextForPrompt({ keyed: false, recentMessages: ['hi'] })).toEqual({
      partial: false,
      hasSaved: false,
    });
  });
});
