import { withDatabase } from './uri';
import { isProductionDbName } from './migrate';

describe('withDatabase', () => {
  it('replaces the database of a single-host string and keeps the options', () => {
    expect(
      withDatabase('mongodb://127.0.0.1:27017/LibreChat?directConnection=true', 'Test'),
    ).toEqual({
      uri: 'mongodb://127.0.0.1:27017/Test?directConnection=true',
      name: 'Test',
    });
  });

  it('handles replica-set strings with several hosts and credentials', () => {
    const uri = 'mongodb://user:p%40ss@a.example:27017,b.example:27017/SynapseProd?replicaSet=rs0';
    expect(withDatabase(uri)).toEqual({ uri, name: 'SynapseProd' });
    expect(isProductionDbName(withDatabase(uri).name)).toBe(true);
    expect(withDatabase(uri, 'Copy')).toEqual({
      uri: 'mongodb://user:p%40ss@a.example:27017,b.example:27017/Copy?replicaSet=rs0',
      name: 'Copy',
    });
  });

  it('handles srv strings and a missing database', () => {
    expect(withDatabase('mongodb+srv://cluster.example/?retryWrites=true')).toEqual({
      uri: 'mongodb+srv://cluster.example/?retryWrites=true',
      name: 'test',
    });
    expect(withDatabase('mongodb://h:1', 'x').uri).toBe('mongodb://h:1/x');
  });

  it('rejects anything that is not a MongoDB string', () => {
    expect(() => withDatabase('http://example.com/db')).toThrow(/mongodb/);
  });
});
