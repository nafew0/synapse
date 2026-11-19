const express = require('express');
const { createProductKeyGuard, createTaskCostHandlers } = require('@librechat/api');

const handlers = createTaskCostHandlers();
const router = express.Router();

router.use(createProductKeyGuard(() => process.env.BDREN_PRODUCT_KEY));
router.get('/task-costs', handlers.getTaskCosts);

module.exports = router;
