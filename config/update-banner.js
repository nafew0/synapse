const path = require('path');
const mongoose = require('mongoose');
const { v5: uuidv5 } = require('uuid');
const { bannerApps, bannerCategories, bannerDisplayModes } = require('librechat-data-provider');
const { Banner } = require('@librechat/data-schemas').createModels(mongoose);
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const { askQuestion, askMultiLineQuestion, askChoice, silentExit } = require('./helpers');
const connect = require('./connect');

/** Same content → same bannerId, so users who already saw an identical announcement are not shown it again. */
const BANNER_ID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::\d{2})?(Z|[+-]\d{2}:\d{2})?$/;
const LINK_PATTERN = /^(https?:\/\/\S+|\/\S*)$/;

const APP_CHOICES = [
  { value: 'chat', label: 'Synapse chat app', hint: 'everyone who uses Synapse' },
  { value: 'admin', label: 'Admin panel', hint: 'only institution and platform admins' },
];

const CATEGORY_CHOICES = [
  { value: 'feature', label: 'New feature', hint: 'orange “New” label' },
  { value: 'update', label: 'Update', hint: 'teal “Update” label' },
  { value: 'maintenance', label: 'Maintenance', hint: 'amber, for planned downtime' },
  { value: 'outage', label: 'Outage', hint: 'red, for something broken right now' },
];

const DISPLAY_CHOICES = [
  { value: 'once', label: 'Show once', hint: 'gone for good after each user has seen it' },
  {
    value: 'until_dismissed',
    label: 'Until dismissed',
    hint: 'every visit until the user closes it',
  },
  { value: 'always', label: 'Always', hint: 'cannot be closed; shown until the end date' },
];

const STYLE_CHOICES = [
  { value: 'popup', label: 'Floating card', hint: 'eye-catching, best for news' },
  { value: 'banner', label: 'Top bar', hint: 'slim, best for maintenance and outages' },
];

const STYLE_FLAGS = { card: 'popup', bar: 'banner' };

const CATEGORY_DEFAULTS = {
  feature: { type: 'popup', display: 'once' },
  update: { type: 'popup', display: 'once' },
  maintenance: { type: 'banner', display: 'until_dismissed' },
  outage: { type: 'banner', display: 'always' },
};

const AUDIENCE_CHOICES = [
  { value: false, label: 'Signed-in users only', hint: 'chat app and admin panel' },
  { value: true, label: 'Everyone', hint: 'also shown on the login page' },
];

const LINK_CHOICES = [
  { value: false, label: 'No link' },
  { value: true, label: 'Add a link', hint: 'e.g. “Learn more →”' },
];

const START_CHOICES = [
  { value: 'now', label: 'Now' },
  { value: 'custom', label: 'Pick a date and time' },
];

const END_CHOICES = [
  { value: null, label: 'No end date', hint: 'stays until you replace or delete it' },
  { value: 1, label: '1 day after it starts' },
  { value: 3, label: '3 days after it starts' },
  { value: 7, label: '7 days after it starts' },
  { value: 30, label: '30 days after it starts' },
  { value: 'custom', label: 'Pick a date and time' },
];

const CONFIRM_CHOICES = [
  { value: true, label: 'Publish' },
  { value: false, label: 'Cancel' },
];

/** Terminal approximation of the chip each category gets in the app. */
const CHIPS = {
  feature: { label: 'NEW', style: '\x1b[48;5;208m\x1b[97m' },
  update: { label: 'UPDATE', style: '\x1b[48;5;30m\x1b[97m' },
  maintenance: { label: 'MAINTENANCE', style: '\x1b[48;5;214m\x1b[30m' },
  outage: { label: 'OUTAGE', style: '\x1b[41m\x1b[97m' },
};

const USAGE = `Usage: npm run update-banner [-- options]

Run without options to be asked each question with a list of choices.
Any option you pass skips its question.

  --app <${bannerApps.join('|')}>          default: chat
  --category <${bannerCategories.join('|')}>
  --title <text>
  --message <text>          HTML allowed: <b>, <i>, <a href="...">
  --style <card|bar>        default: card for feature/update, bar otherwise
  --display <${bannerDisplayModes.join('|')}>
  --link-label <text>       --link-url <https://... or /path>
  --public <true|false>     true also shows it on the login page
  --from <date>             default: now
  --to <date|none>          default: no end date
  --yes                     skip remaining questions and publish (needs --message)

Dates: "YYYY-MM-DD HH:mm" in this machine's time zone (${timeZoneLabel(new Date())}),
or with an explicit offset, e.g. "2026-09-13 02:00+06:00" or "2026-09-12T20:00:00Z".`;

/** @param {Date} date */
function timeZoneLabel(date) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const hours = Math.floor(Math.abs(offset) / 60);
  const minutes = Math.abs(offset) % 60;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `${zone}, GMT${sign}${hours}${minutes ? `:${String(minutes).padStart(2, '0')}` : ''}`;
}

/** @param {Date | null} date */
function formatDate(date) {
  if (!date) {
    return 'no end date';
  }
  const text = date.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  return `${text} (${timeZoneLabel(date)})`;
}

/** @param {string} input @returns {Date | null} */
function parseDate(input) {
  const match = DATE_PATTERN.exec(input.trim());
  if (!match) {
    return null;
  }
  const [, year, month, day, hour, minute, zone] = match;
  const date = zone
    ? new Date(`${year}-${month}-${day}T${hour}:${minute}:00${zone}`)
    : new Date(+year, +month - 1, +day, +hour, +minute);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** @param {string} message */
function fail(message) {
  console.red(`Error: ${message}`);
  silentExit(1);
}

/**
 * @param {string} name
 * @param {string} value
 * @param {readonly string[]} allowed
 */
function assertOneOf(name, value, allowed) {
  if (!allowed.includes(value)) {
    fail(`--${name} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

/** @param {string} name @param {string} value */
function parseDateFlag(name, value) {
  if (name === 'to' && value === 'none') {
    return null;
  }
  const date = parseDate(value);
  if (!date) {
    fail(`--${name} "${value}" is not a valid date. Use "YYYY-MM-DD HH:mm".`);
  }
  return date;
}

const FLAG_PARSERS = {
  app: (value) => assertOneOf('app', value, bannerApps),
  category: (value) => assertOneOf('category', value, bannerCategories),
  display: (value) => assertOneOf('display', value, bannerDisplayModes),
  style: (value) => STYLE_FLAGS[assertOneOf('style', value, Object.keys(STYLE_FLAGS))],
  public: (value) => assertOneOf('public', value, ['true', 'false']) === 'true',
  title: (value) => value.trim(),
  message: (value) => value.trim(),
  'link-label': (value) => value.trim(),
  'link-url': (value) => value.trim(),
  from: (value) => parseDateFlag('from', value),
  to: (value) => parseDateFlag('to', value),
};

/** @param {string[]} argv */
function parseFlags(argv) {
  /** @type {Record<string, string | boolean | Date | null>} */
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      silentExit(0);
    }
    if (arg === '--yes' || arg === '-y') {
      flags.yes = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      fail(
        `Unexpected argument "${arg}". The positional form was replaced by named options.\n\n${USAGE}`,
      );
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/s);
    const parse = FLAG_PARSERS[name];
    if (!parse) {
      fail(`Unknown option --${name}\n\n${USAGE}`);
    }
    const value = inline ?? argv[++i];
    if (value === undefined) {
      fail(`--${name} needs a value`);
    }
    flags[name] = parse(value);
  }

  if (flags.yes && !flags.message) {
    fail('--message is required when using --yes');
  }
  if (flags.app === 'admin' && flags.public) {
    fail('Admin panel banners are only shown to admins; --public cannot be used with --app admin');
  }
  if (flags['link-label'] && !flags['link-url']) {
    fail('--link-label needs --link-url');
  }
  if (flags['link-url'] && !LINK_PATTERN.test(flags['link-url'])) {
    fail('--link-url must start with https://, http:// or /');
  }
  return flags;
}

/** @param {string} query @param {Date | null} [after] @returns {Promise<Date>} */
async function askDate(query, after = null) {
  for (;;) {
    const answer = await askQuestion(
      `${query}\nFormat YYYY-MM-DD HH:mm, time zone ${timeZoneLabel(new Date())}:`,
    );
    const date = parseDate(answer);
    if (!date) {
      console.red('That is not a valid date. Example: 2026-09-13 02:00');
      continue;
    }
    if (after && date <= after) {
      console.red(`It must be after the start (${formatDate(after)}).`);
      continue;
    }
    return date;
  }
}

/** @param {string} query @param {(value: string) => string | null} validate */
async function askText(query, validate) {
  for (;;) {
    const answer = (await askQuestion(query)).trim();
    const error = validate(answer);
    if (!error) {
      return answer;
    }
    console.red(error);
  }
}

async function askLink(flags) {
  if (flags['link-url']) {
    return { linkLabel: flags['link-label'] || 'Learn more', linkUrl: flags['link-url'] };
  }
  if (flags.yes || !(await askChoice('Add a link to the announcement?', LINK_CHOICES))) {
    return { linkLabel: '', linkUrl: '' };
  }
  const linkLabel =
    (await askQuestion('Link text (press Enter for “Learn more”):')).trim() || 'Learn more';
  const linkUrl = await askText('Link address (https://... or a path like /c/new):', (value) =>
    LINK_PATTERN.test(value) ? null : 'The link must start with https://, http:// or /',
  );
  return { linkLabel, linkUrl };
}

async function askStart(flags) {
  if (flags.from !== undefined) {
    return flags.from;
  }
  if (flags.yes || (await askChoice('When should it start showing?', START_CHOICES)) === 'now') {
    return new Date();
  }
  return askDate('Start date and time');
}

/** @param {Record<string, unknown>} flags @param {Date} start */
async function askEnd(flags, start) {
  if (flags.to !== undefined) {
    return flags.to;
  }
  if (flags.yes) {
    return null;
  }
  const choice = await askChoice('When should it stop showing?', END_CHOICES);
  if (choice === 'custom') {
    return askDate('End date and time', start);
  }
  return choice == null ? null : new Date(start.getTime() + choice * DAY_MS);
}

/** Chat banners saved before the `app` field existed have none. */
const appFilter = (app) => (app === 'chat' ? { app: { $in: ['chat', null] } } : { app });

async function askApp(flags) {
  if (flags.app) {
    return flags.app;
  }
  if (flags.yes) {
    return 'chat';
  }
  return askChoice('Which app is this announcement for?', APP_CHOICES);
}

async function collectBanner(flags, app) {
  const category =
    flags.category ?? (await askChoice('What kind of announcement is this?', CATEGORY_CHOICES));

  const title =
    flags.title ??
    (flags.yes
      ? ''
      : (await askQuestion('Title — a short headline (optional, press Enter to skip):')).trim());

  const message =
    flags.message ??
    (
      await askMultiLineQuestion(
        'Message — one or two sentences. <b>, <i> and <a href="..."> are allowed.\nType a single "." on its own line to finish:',
      )
    ).trim();
  if (!message) {
    fail('The message cannot be empty.');
  }

  const { linkLabel, linkUrl } = await askLink(flags);

  const defaults = CATEGORY_DEFAULTS[category];
  const type =
    flags.style ??
    (flags.yes
      ? defaults.type
      : await askChoice(
          'How should it appear?',
          STYLE_CHOICES,
          indexOfValue(STYLE_CHOICES, defaults.type),
        ));

  const display =
    flags.display ??
    (flags.yes
      ? defaults.display
      : await askChoice(
          'How often should each user see it?',
          DISPLAY_CHOICES,
          indexOfValue(DISPLAY_CHOICES, defaults.display),
        ));

  const isPublic =
    app === 'admin'
      ? false
      : (flags.public ??
        (flags.yes ? false : await askChoice('Who should see it?', AUDIENCE_CHOICES)));

  const displayFrom = await askStart(flags);
  const displayTo = await askEnd(flags, displayFrom);
  if (displayTo && displayTo <= displayFrom) {
    fail('The end date must be after the start date.');
  }

  /** `app` is only mixed in for admin banners so existing chat banner ids stay the same. */
  const idParts = [category, title, message, linkUrl, ...(app === 'admin' ? [app] : [])];
  const bannerId = uuidv5(idParts.join('\n'), BANNER_ID_NAMESPACE);
  return {
    bannerId,
    app,
    type,
    category,
    title,
    message,
    linkLabel,
    linkUrl,
    display,
    isPublic,
    displayFrom,
    displayTo,
  };
}

const stripTags = (html) => html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ');
const labelOf = (choices, value) => choices.find((choice) => choice.value === value)?.label;
const indexOfValue = (choices, value) => choices.findIndex((choice) => choice.value === value);

const CARD_WIDTH = 44;
/** Matches ANSI colour codes so padding is based on what the terminal actually shows. */
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
const visibleLength = (text) => text.replace(ANSI_PATTERN, '').length;

/** @param {string} text @returns {string[]} */
function wrap(text, width) {
  return text.split(' ').reduce(
    (lines, word) => {
      const last = lines[lines.length - 1];
      if (last && (last + ' ' + word).length > width) {
        return [...lines, word];
      }
      lines[lines.length - 1] = last ? `${last} ${word}` : word;
      return lines;
    },
    [''],
  );
}

function printBarPreview(banner, chip) {
  const title = banner.title ? ` \x1b[1m${banner.title}\x1b[0m` : '';
  const link = banner.linkUrl ? `  \x1b[4m\x1b[36m${banner.linkLabel} →\x1b[0m` : '';
  const close = banner.display === 'always' ? '' : '  \x1b[90m×\x1b[0m';
  console.log(`\n  ${chip}${title}  ${stripTags(banner.message)}${link}${close}\n`);
}

function printCardPreview(banner, chip) {
  const inner = CARD_WIDTH - 4;
  const row = (text = '') => `  │ ${text}${' '.repeat(Math.max(0, inner - visibleLength(text)))} │`;
  const close = banner.display === 'always' ? ' ' : '×';
  const actions = [
    banner.linkUrl ? `\x1b[48;5;208m\x1b[97m ${banner.linkLabel} \x1b[0m` : '',
    banner.display === 'always' ? '' : '[ Got it ]',
  ]
    .filter(Boolean)
    .join('  ');
  const lines = [
    `  ╭${'─'.repeat(CARD_WIDTH - 2)}╮`,
    row(`${chip}${' '.repeat(Math.max(1, inner - visibleLength(chip) - 1))}${close}`),
    row(),
    ...(banner.title ? wrap(banner.title, inner).map((line) => row(`\x1b[1m${line}\x1b[0m`)) : []),
    ...wrap(stripTags(banner.message), inner).map((line) => row(line)),
    ...(actions ? [row(), row(actions)] : []),
    `  ╰${'─'.repeat(CARD_WIDTH - 2)}╯`,
  ];
  console.log(`\n${lines.join('\n')}\n`);
}

function printPreview(banner) {
  const { label, style } = CHIPS[banner.category];
  const chip = `${style} ${label} \x1b[0m`;
  if (banner.type === 'popup') {
    printCardPreview(banner, chip);
    return;
  }
  printBarPreview(banner, chip);
}

function printSummary(banner, current) {
  const rows = [
    ['App', labelOf(APP_CHOICES, banner.app)],
    ['Type', labelOf(CATEGORY_CHOICES, banner.category)],
    ['Style', labelOf(STYLE_CHOICES, banner.type)],
    ['Title', banner.title || '—'],
    ['Link', banner.linkUrl ? `${banner.linkLabel} → ${banner.linkUrl}` : '—'],
    ['Shown', labelOf(DISPLAY_CHOICES, banner.display)],
    [
      'Audience',
      banner.app === 'admin' ? 'Admins only' : labelOf(AUDIENCE_CHOICES, banner.isPublic),
    ],
    ['Starts', formatDate(banner.displayFrom)],
    ['Ends', formatDate(banner.displayTo)],
  ];
  console.purple('--------------------------');
  console.purple('Preview');
  printPreview(banner);
  rows.forEach(([label, value]) => console.log(`  ${label.padEnd(9)} ${value}`));
  if (current) {
    console.orange(
      `\nThis replaces the current ${labelOf(APP_CHOICES, banner.app)} banner: “${stripTags(current.title || current.message)}”`,
    );
  }
  if (current?.bannerId === banner.bannerId) {
    console.orange(
      'The content is unchanged, so users who already saw or closed it will not see it again.',
    );
  }
  console.purple('--------------------------');
}

async function saveBanner(banner) {
  const optional = ['title', 'linkLabel', 'linkUrl', 'displayTo'];
  const $unset = Object.fromEntries(optional.filter((key) => !banner[key]).map((key) => [key, 1]));
  const $set = Object.fromEntries(Object.entries(banner).filter(([key]) => !(key in $unset)));
  $set.persistable = banner.display === 'always';
  const update = Object.keys($unset).length ? { $set, $unset } : { $set };
  return Banner.findOneAndUpdate(appFilter(banner.app), update, { upsert: true, new: true });
}

(async () => {
  const flags = parseFlags(process.argv.slice(2));
  await connect();

  console.purple('--------------------------');
  console.purple('Update the Synapse announcement banner');
  console.purple('--------------------------');
  console.gray('Tip: run with --help to see options for scripted use.\n');

  const app = await askApp(flags);
  const current = await Banner.findOne(appFilter(app)).lean();
  const banner = await collectBanner(flags, app);
  printSummary(banner, current);

  const confirmed = flags.yes || (await askChoice('Publish this announcement?', CONFIRM_CHOICES));
  if (!confirmed) {
    console.yellow('Cancelled. Nothing was changed.');
    silentExit(0);
  }

  try {
    await saveBanner(banner);
  } catch (error) {
    console.red('Error: ' + error.message);
    console.error(error);
    silentExit(1);
  }

  console.green('Announcement published.');
  console.purple(`bannerId: ${banner.bannerId}`);
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
