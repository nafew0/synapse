import { summarizeThought } from '../Reasoning';

describe('summarizeThought', () => {
  it('uses the first line without markdown', () => {
    expect(summarizeThought('**Planning the conversion**\n\nThe PDF has two tables.')).toBe(
      'Planning the conversion',
    );
  });

  it('skips leading blank lines and collapses spaces', () => {
    expect(summarizeThought('\n\n  ## Checking   the   template  \nmore')).toBe(
      'Checking the template',
    );
  });

  it('returns nothing for an empty thought', () => {
    expect(summarizeThought('   \n ')).toBe('');
  });
});
