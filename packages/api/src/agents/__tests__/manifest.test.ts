import fs from 'fs';
import path from 'path';
import { load } from 'js-yaml';
import { extractLibreChatParams } from '~/utils/llm';

type Manifest = {
  master: { model_parameters: Record<string, unknown> };
};

const manifestPath = path.resolve(__dirname, '../../../../../config/phase-one-office-agents.yaml');

describe('Office Assistant manifest model_parameters', () => {
  const manifest = load(fs.readFileSync(manifestPath, 'utf8')) as Manifest;
  const params = extractLibreChatParams(manifest.master.model_parameters);

  it('sets the context window just under the 100K price jump', () => {
    expect(params.maxContextTokens).toBe(90000);
  });

  it('caps a single tool result at 10,000 characters', () => {
    expect(params.maxToolResultChars).toBe(10000);
  });

  it('keeps LibreChat-only keys out of the model request options', () => {
    expect(params.modelOptions).toEqual({ reasoning_effort: 'medium' });
  });
});
