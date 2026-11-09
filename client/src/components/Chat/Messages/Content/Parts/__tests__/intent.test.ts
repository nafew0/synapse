import { getToolCallIntent } from '../intent';

describe('getToolCallIntent', () => {
  it('reads a first-key label for any tool, even mid-stream', () => {
    expect(getToolCallIntent('{"intent":"Looking up the customer')).toBe('Looking up the customer');
    expect(getToolCallIntent({ intent: 'Looking up', q: 'acme' })).toBe('Looking up');
  });

  it('ignores a later intent on an unknown tool, where it may be a business field', () => {
    expect(getToolCallIntent('{"q":"acme","intent":"billing"}', 'crm_search')).toBeUndefined();
    expect(getToolCallIntent({ q: 'acme', intent: 'billing' })).toBeUndefined();
  });

  it('reads a later intent on our own tools once the args are complete', () => {
    expect(
      getToolCallIntent('{"path":"docx/SKILL.md","intent":"Reading the guide"}', 'read_file'),
    ).toBe('Reading the guide');
    expect(getToolCallIntent({ command: 'ls', intent: 'Listing files' }, 'bash_tool')).toBe(
      'Listing files',
    );
    expect(getToolCallIntent('{"query":"bdren","intent":"Searching news"}', 'search_web')).toBe(
      'Searching news',
    );
  });

  it('does not read a later intent from args still streaming', () => {
    expect(getToolCallIntent('{"command":"ls","intent":"Listing', 'bash_tool')).toBeUndefined();
  });
});
