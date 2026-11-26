const MONGO_URI = /^(mongodb(?:\+srv)?:\/\/[^/?]+)(?:\/([^?]*))?(\?.*)?$/;

/**
 * A MongoDB connection string with its database replaced by `db` (when given), and the database
 * name in effect. Works for replica-set strings with several hosts, which `new URL` rejects.
 */
export function withDatabase(uri: string, db?: string): { uri: string; name: string } {
  const match = uri.trim().match(MONGO_URI);
  if (!match) {
    throw new Error('MONGO_URI is not a mongodb:// or mongodb+srv:// connection string');
  }
  const [, hosts, path = '', query = ''] = match;
  const database = db ? encodeURIComponent(db) : path;
  return {
    uri: `${hosts}/${database}${query}`,
    name: decodeURIComponent(database) || 'test',
  };
}
