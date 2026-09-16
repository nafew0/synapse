const mockFindInstitutionInviteByToken = jest.fn();
const mockResolveInstitutionInviteByToken = jest.fn();

jest.mock('~/server/services/institutionMembers', () => ({
  findInstitutionInviteByToken: (...args) => mockFindInstitutionInviteByToken(...args),
  resolveInstitutionInviteByToken: (...args) => mockResolveInstitutionInviteByToken(...args),
  InstitutionInviteStatuses: {
    PENDING: 'pending',
    ACCEPTED: 'accepted',
    REVOKED: 'revoked',
    EXPIRED: 'expired',
  },
}));

const checkInviteUser = require('./checkInviteUser');

function invoke(invite, byToken = null) {
  mockFindInstitutionInviteByToken.mockResolvedValue(invite);
  mockResolveInstitutionInviteByToken.mockResolvedValue(byToken);
  const req = { body: { token: 'token', email: 'admin@example.com' } };
  const next = jest.fn();
  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json: jest.fn(),
  };
  return checkInviteUser(req, res, next).then(() => ({ req, res, next }));
}

describe('checkInviteUser', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /** The token+email lookup cannot tell these three apart on its own; resolving by token
   *  alone is what makes the message accurate. */
  it('reports an unknown token as invalid', async () => {
    const { res, next } = await invoke(null, null);

    expect(res.statusCode).toBe(400);
    expect(res.json).toHaveBeenCalledWith({ message: 'Invalid invite token' });
    expect(next).not.toHaveBeenCalled();
  });

  it('reports a valid token submitted with the wrong email', async () => {
    const { res, next } = await invoke(null, { status: 'pending' });

    expect(res.statusCode).toBe(400);
    expect(res.json).toHaveBeenCalledWith({
      message:
        'This invitation was issued for a different email address. Register with the address it was sent to.',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('reports an accepted invitation even when the email does not match', async () => {
    const { res, next } = await invoke(null, { status: 'accepted' });

    expect(res.statusCode).toBe(409);
    expect(res.json).toHaveBeenCalledWith({
      message: 'This invitation has already been accepted. Please log in or reset your password.',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('reports an expired invitation even when the email does not match', async () => {
    const { res, next } = await invoke(null, { status: 'expired' });

    expect(res.statusCode).toBe(410);
    expect(next).not.toHaveBeenCalled();
  });

  it('explains that an accepted invitation must not be reused', async () => {
    const { res, next } = await invoke({ status: 'accepted' });

    expect(res.statusCode).toBe(409);
    expect(res.json).toHaveBeenCalledWith({
      message: 'This invitation has already been accepted. Please log in or reset your password.',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('allows a pending invitation to continue registration', async () => {
    const invite = { _id: 'invite-1', status: 'pending' };
    const { req, next } = await invoke(invite);

    expect(req.invite).toBe(invite);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
