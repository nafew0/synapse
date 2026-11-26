const crypto = require('crypto');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

describe('quota refusals persist to the thread', () => {
  let mongod, models, saveMessage, quota;
  const userId = new mongoose.Types.ObjectId();

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    models = require('~/db/models');
    ({ saveMessage } = require('~/models'));
    quota = require('~/server/services/usageQuota');
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await mongod?.stop();
  });
  beforeEach(async () => {
    await models.Message.deleteMany({});
    await models.Conversation.deleteMany({});
  });

  /** Mirrors `persistQuotaRefusal`: the envelope is stored verbatim as the
   *  message text so a reloaded thread renders the same notice the stream did. */
  const persist = async ({ conversationId, responseMessageId, parentMessageId, error }) =>
    saveMessage(
      { userId: String(userId), isTemporary: false },
      {
        user: String(userId),
        messageId: responseMessageId,
        conversationId,
        parentMessageId,
        sender: 'System',
        text: error.message,
        isCreatedByUser: false,
        error: true,
        unfinished: false,
        final: true,
      },
      { context: 'test' },
    );

  it('stores the refusal envelope so the notice survives a reload', async () => {
    const error = new quota.QuotaError({
      limitCode: 'IMAGE_MONTHLY_CAP',
      window: 'month',
      meter: 'images',
      resetAt: '2026-10-01T00:00:00.000Z',
    });
    /** `saveMessage` requires a UUID conversationId and silently returns otherwise. */
    const conversationId = crypto.randomUUID();
    await persist({
      conversationId,
      responseMessageId: 'resp-1',
      parentMessageId: 'user-1',
      error,
    });

    const stored = await models.Message.findOne({ conversationId, messageId: 'resp-1' }).lean();
    expect(stored).not.toBeNull();
    expect(stored.error).toBe(true);
    expect(stored.isCreatedByUser).toBe(false);
    /** The client keys its localized copy off this envelope; storing prose here
     *  would render the generic "Something went wrong" wrapper on reload. */
    const envelope = JSON.parse(stored.text);
    expect(envelope.type).toBe('token_quota_exceeded');
    expect(envelope.limitCode).toBe('IMAGE_MONTHLY_CAP');
    expect(envelope.resetAt).toBe('2026-10-01T00:00:00.000Z');
  });

  it('keeps the refusal attached to the prompt that caused it', async () => {
    const error = new quota.QuotaError({ limitCode: 'WEEKLY_CAP', window: 'week' });
    await persist({
      conversationId: crypto.randomUUID(),
      responseMessageId: 'resp-2',
      parentMessageId: 'user-2',
      error,
    });
    const stored = await models.Message.findOne({ messageId: 'resp-2' }).lean();
    expect(stored.parentMessageId).toBe('user-2');
  });

  /** Only enforcement denials are persisted; a transient generation failure must
   *  not start filling histories with error bubbles. */
  it('recognises which errors are quota refusals', () => {
    const denial = new quota.QuotaError({ limitCode: 'WEEKLY_CAP' });
    expect(quota.isEnforcementDenial(denial)).toBe(true);
    expect(quota.isEnforcementDenial(new Error('socket hang up'))).toBe(false);
  });

  it('does not persist a temporary chat', async () => {
    const conversationId = crypto.randomUUID();
    await saveMessage(
      { userId: String(userId), isTemporary: true },
      {
        user: String(userId),
        messageId: 'resp-temp',
        conversationId,
        parentMessageId: 'user-temp',
        sender: 'System',
        text: new quota.QuotaError({ limitCode: 'WEEKLY_CAP' }).message,
        isCreatedByUser: false,
        error: true,
      },
      { context: 'test' },
    );
    const stored = await models.Message.findOne({ messageId: 'resp-temp' }).lean();
    /** A temporary chat expires; the helper skips it outright so a refusal is
     *  never the thing that outlives the conversation it belonged to. */
    expect(stored?.isTemporary).toBe(true);
  });
});
