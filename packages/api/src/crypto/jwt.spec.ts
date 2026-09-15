import jwt from 'jsonwebtoken';
import {
  AGENT_TRIGGER_SCOPE,
  generateAgentTriggerToken,
  generateShortLivedToken,
  isAgentTriggerRequest,
} from './jwt';

function request(token: string, marker = true) {
  return {
    headers: {
      ...(marker && { 'x-lc-agent-trigger': '1' }),
      authorization: `Bearer ${token}`,
    },
  };
}

describe('agent trigger identity', () => {
  const original = process.env.JWT_SECRET;

  beforeAll(() => {
    process.env.JWT_SECRET = 'test-secret';
  });

  afterAll(() => {
    if (original == null) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = original;
    }
  });

  it('recognizes only a signed trigger scope with its transport marker', () => {
    const trigger = generateAgentTriggerToken('user-1');
    const ordinary = generateShortLivedToken('user-1');

    expect(isAgentTriggerRequest(request(trigger))).toBe(true);
    expect(isAgentTriggerRequest(request(trigger, false))).toBe(false);
    expect(isAgentTriggerRequest(request(ordinary))).toBe(false);
    expect(isAgentTriggerRequest(request('invalid'))).toBe(false);
  });

  it('uses the dedicated trigger scope without changing ordinary tokens', () => {
    const trigger = generateAgentTriggerToken('user-1');
    const payload = JSON.parse(Buffer.from(trigger.split('.')[1], 'base64url').toString()) as {
      id: string;
      scope: string;
    };

    expect(payload).toMatchObject({ id: 'user-1', scope: AGENT_TRIGGER_SCOPE });
    expect(generateShortLivedToken('user-1')).not.toBe(trigger);
  });
});

describe('RAG API tokens', () => {
  const original = { jwt: process.env.JWT_SECRET, rag: process.env.RAG_JWT_SECRET };

  const restore = (key: 'JWT_SECRET' | 'RAG_JWT_SECRET', value: string | undefined) => {
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  };

  beforeEach(() => {
    process.env.JWT_SECRET = 'session-secret';
    delete process.env.RAG_JWT_SECRET;
  });

  afterAll(() => {
    restore('JWT_SECRET', original.jwt);
    restore('RAG_JWT_SECRET', original.rag);
  });

  it('signs with RAG_JWT_SECRET, so the session secret cannot verify it', () => {
    process.env.RAG_JWT_SECRET = 'rag-secret';
    const token = generateShortLivedToken('user-1');

    expect(jwt.verify(token, 'rag-secret', { algorithms: ['HS256'] })).toMatchObject({
      id: 'user-1',
    });
    expect(() => jwt.verify(token, 'session-secret', { algorithms: ['HS256'] })).toThrow(
      'invalid signature',
    );
  });

  it('falls back to JWT_SECRET when RAG_JWT_SECRET is unset or empty', () => {
    const unset = generateShortLivedToken('user-1');
    process.env.RAG_JWT_SECRET = '';
    const empty = generateShortLivedToken('user-1');

    for (const token of [unset, empty]) {
      expect(jwt.verify(token, 'session-secret', { algorithms: ['HS256'] })).toMatchObject({
        id: 'user-1',
      });
    }
  });

  it('keeps agent trigger tokens on the session secret', () => {
    process.env.RAG_JWT_SECRET = 'rag-secret';
    const trigger = generateAgentTriggerToken('user-1');

    expect(isAgentTriggerRequest(request(trigger))).toBe(true);
    expect(() => jwt.verify(trigger, 'rag-secret', { algorithms: ['HS256'] })).toThrow(
      'invalid signature',
    );
  });
});
