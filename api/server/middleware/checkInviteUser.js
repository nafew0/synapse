const {
  findInstitutionInviteByToken,
  resolveInstitutionInviteByToken,
  InstitutionInviteStatuses,
} = require('~/server/services/institutionMembers');

const EMAIL_MISMATCH_MESSAGE =
  'This invitation was issued for a different email address. Register with the address it was sent to.';

/** @returns {{ status: number, message: string } | null} */
function rejectionFor(invite) {
  if (invite.status === InstitutionInviteStatuses.ACCEPTED) {
    return {
      status: 409,
      message: 'This invitation has already been accepted. Please log in or reset your password.',
    };
  }
  if (
    invite.status === InstitutionInviteStatuses.EXPIRED ||
    invite.status === InstitutionInviteStatuses.REVOKED
  ) {
    return {
      status: 410,
      message: 'This invitation has expired or was revoked. Ask your administrator to resend it.',
    };
  }
  return null;
}

async function checkInviteUser(req, res, next) {
  const token = req.body.token;

  if (!token || token === 'undefined') {
    next();
    return;
  }

  try {
    const invite = await findInstitutionInviteByToken(token, req.body.email);

    if (invite) {
      const rejection = rejectionFor(invite);
      if (rejection) {
        return res.status(rejection.status).json({ message: rejection.message });
      }
      req.invite = invite;
      next();
      return;
    }

    /** The lookup above matches on token *and* email, so a miss is ambiguous. Resolving by
     *  token alone tells an unknown link apart from a spent one or a mismatched address,
     *  and costs a second read only on this failure path. */
    const byToken = await resolveInstitutionInviteByToken(token);
    if (!byToken) {
      return res.status(400).json({ message: 'Invalid invite token' });
    }

    const rejection = rejectionFor(byToken);
    if (rejection) {
      return res.status(rejection.status).json({ message: rejection.message });
    }

    return res.status(400).json({ message: EMAIL_MISMATCH_MESSAGE });
  } catch (error) {
    return res.status(429).json({ message: error.message });
  }
}

module.exports = checkInviteUser;
