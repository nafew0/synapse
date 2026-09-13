const path = require('path');
const mongoose = require('mongoose');
const { Banner } = require('@librechat/data-schemas').createModels(mongoose);
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const { askChoice, silentExit } = require('./helpers');
const connect = require('./connect');

const APP_LABELS = { chat: 'Synapse chat app', admin: 'Admin panel' };

const appLabel = (banner) => APP_LABELS[banner.app ?? 'chat'];
const bannerLabel = (banner) => `${appLabel(banner)}: ${banner.title || banner.message}`;

/** @param {Array<Record<string, unknown>>} banners */
async function pickBanner(banners) {
  if (banners.length === 1) {
    return banners[0];
  }
  return askChoice(
    'Which banner do you want to delete?',
    banners.map((banner) => ({ value: banner, label: bannerLabel(banner) })),
  );
}

(async () => {
  await connect();

  console.purple('--------------------------');
  console.purple('Delete the banner!');
  console.purple('--------------------------');

  const now = new Date();

  try {
    const banners = await Banner.find({
      displayFrom: { $lte: now },
      $or: [{ displayTo: { $gte: now } }, { displayTo: null }],
    })
      .sort({ app: 1, displayFrom: -1 })
      .lean();

    if (!banners.length) {
      console.yellow('No banner found to delete.');
      silentExit(0);
    }

    const banner = await pickBanner(banners);

    console.purple('Current banner:');
    console.log(`App: ${appLabel(banner)}`);
    console.log(`Type: ${banner.category ?? 'update'}`);
    console.log(`Title: ${banner.title || '—'}`);
    console.log(`Message: ${banner.message}`);
    console.log(`Shown: ${banner.display ?? (banner.persistable ? 'always' : 'until_dismissed')}`);
    console.log(`Display From: ${banner.displayFrom}`);
    console.log(`Display To: ${banner.displayTo || 'Not specified'}`);
    console.log(`Is Public: ${banner.isPublic}`);

    const confirmed = await askChoice('Delete this banner?', [
      { value: false, label: 'Cancel' },
      { value: true, label: 'Delete' },
    ]);

    if (confirmed) {
      await Banner.findByIdAndDelete(banner._id);
      console.green('Banner deleted successfully!');
    } else {
      console.yellow('Banner deletion cancelled.');
    }
  } catch (error) {
    console.red('Error: ' + error.message);
    console.error(error);
    silentExit(1);
  }

  silentExit(0);
})();

process.on('uncaughtException', (err) => {
  if (!err.message.includes('fetch failed')) {
    console.error('There was an uncaught error:');
    console.error(err);
  }

  if (err.message.includes('fetch failed')) {
    return;
  } else {
    process.exit(1);
  }
});
