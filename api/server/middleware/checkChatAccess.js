const { createChatAccessGuard } = require('@librechat/api');
const denyRequest = require('./denyRequest');

module.exports = createChatAccessGuard(denyRequest);
