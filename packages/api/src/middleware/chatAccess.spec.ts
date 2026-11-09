import mongoose from 'mongoose';
import { ErrorTypes } from 'librechat-data-provider';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, createMethods } from '@librechat/data-schemas';
import type { AllMethods } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';
import { createChatAccessGuard, getChatAccessDenial } from './chatAccess';
import { validateActiveInstitution } from './institution';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { error: jest.fn(), warn: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

const message = 'Your free trial has finished. Please contact LEARN to get more usage.';

let mongoServer: MongoMemoryServer;
let methods: AllMethods;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  methods = createMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  await methods.createInstitution({ tenantId: 'learn', name: 'LEARN' });
  await methods.createInstitution({ tenantId: 'bdren', name: 'BdREN' });
});

/** The request as `tenantContextMiddleware` leaves it: with the institution it read attached. */
async function requestFor(tenantId: string): Promise<ServerRequest> {
  const result = await validateActiveInstitution(tenantId);
  if (!result.ok) {
    throw new Error(`institution ${tenantId} is not active`);
  }
  return { institution: result.institution } as ServerRequest;
}

describe('chat access', () => {
  it('refuses members of an institution whose access has ended, with its message', async () => {
    await methods.setInstitutionChatAccess('learn', { ended: true, message: ` ${message} ` });

    expect(getChatAccessDenial(await requestFor('learn'))).toEqual({
      type: ErrorTypes.CHAT_ACCESS_ENDED,
      info: message,
    });
  });

  it('keeps other institutions open', async () => {
    await methods.setInstitutionChatAccess('learn', { ended: true, message });

    expect(getChatAccessDenial(await requestFor('bdren'))).toBeNull();
  });

  it('refuses without a message when none was set, so the client shows its own copy', async () => {
    await methods.setInstitutionChatAccess('learn', { ended: true });

    expect(getChatAccessDenial(await requestFor('learn'))).toEqual({
      type: ErrorTypes.CHAT_ACCESS_ENDED,
    });
  });

  it('opens chat again once access is restored', async () => {
    await methods.setInstitutionChatAccess('learn', { ended: true, message });
    await methods.setInstitutionChatAccess('learn', { ended: false });

    expect(getChatAccessDenial(await requestFor('learn'))).toBeNull();
  });

  it('keeps the institution active, so members can still sign in and read their chats', async () => {
    await methods.setInstitutionChatAccess('learn', { ended: true, message });

    await expect(validateActiveInstitution('learn')).resolves.toMatchObject({ ok: true });
  });

  it('leaves users without an institution alone', () => {
    expect(getChatAccessDenial({} as ServerRequest)).toBeNull();
  });

  it('rejects a message longer than 500 characters', async () => {
    await expect(
      methods.setInstitutionChatAccess('learn', { ended: true, message: 'x'.repeat(501) }),
    ).rejects.toThrow();
  });

  it('cannot be changed through the generic institution update', async () => {
    await methods.updateInstitutionByTenantId('learn', {
      chatAccess: { ended: true, message },
    });

    expect(getChatAccessDenial(await requestFor('learn'))).toBeNull();
  });
});

describe('createChatAccessGuard', () => {
  const res = {} as Response;

  it('denies before the chat runs when access has ended', async () => {
    await methods.setInstitutionChatAccess('learn', { ended: true, message });
    const deny = jest.fn().mockResolvedValue(undefined);
    const next = jest.fn();
    const req = await requestFor('learn');

    await createChatAccessGuard(deny)(req, res, next);

    expect(deny).toHaveBeenCalledWith(req, res, {
      type: ErrorTypes.CHAT_ACCESS_ENDED,
      info: message,
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('passes the request on when access is open', async () => {
    const deny = jest.fn();
    const next = jest.fn();

    await createChatAccessGuard(deny)(await requestFor('bdren'), res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(deny).not.toHaveBeenCalled();
  });
});
