const fs = require('fs');
const path = require('path');
const handlebars = require('handlebars');

const TEMPLATE_PATH = path.join(__dirname, 'inviteUser.handlebars');
const ASSETS_DIR = path.join(__dirname, '../../../../client/public/assets');

const basePayload = {
  appName: 'Synapse',
  appUrl: 'https://synapse.example.net',
  inviteLink: 'https://synapse.example.net/register?token=abc123',
  year: 2026,
};

const fullPayload = {
  ...basePayload,
  name: 'Nafisa',
  email: 'nafisa.rahman@du.ac.bd',
  institutionName: 'University of Dhaka',
  expiresOn: '25 September 2026',
  supportEmail: 'info@bdren.ai',
  orgUrl: 'https://bdren.net.bd',
  orgLabel: 'bdren.net.bd',
};

const render = (payload) => handlebars.compile(fs.readFileSync(TEMPLATE_PATH, 'utf8'))(payload);

/** The template wraps for readability and handlebars escapes what it prints, so
 *  copy is asserted the way a reader sees it rather than the way it is stored.
 *  `=` becoming `&#x3D;` inside the invite link is the one that bites. */
const text = (payload) =>
  render(payload)
    .replace(/&#x3D;/g, '=')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '\u2014')
    .replace(/&middot;/g, '\u00b7')
    .replace(/&copy;/g, '\u00a9')
    .replace(/&rarr;/g, '\u2192')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

describe('inviteUser email template', () => {
  it('renders every invitation detail it was given', () => {
    const html = text(fullPayload);

    expect(html).not.toContain('Invitation \u00b7');
    expect(html).toContain('You are invited to join Synapse.');
    expect(html).toContain('Invitation expires 25 September 2026.');
    expect(html).toContain(fullPayload.inviteLink);
  });

  it('shows the expiry as plain text and no details table', () => {
    const html = text(fullPayload);

    expect(html).not.toContain('ACCOUNT');
    expect(html).not.toContain('ORGANIZATION');
    expect(html).not.toContain('INVITATION EXPIRES');
    expect(html).not.toContain('University of Dhaka has invited you');
    expect(html).toMatch(/<p class="body"[^>]*>Invitation expires 25 September 2026\.<\/p>/);
  });

  it('leaves the expiry line out when there is no deadline', () => {
    expect(text(basePayload)).not.toContain('Invitation expires');
  });

  it('stops at the invitation: no feature list, sign-off, ignore note or contact line', () => {
    [fullPayload, basePayload].forEach((payload) => {
      const html = text(payload);

      expect(html).not.toContain('WHAT YOU CAN DO WITH IT');
      expect(html).not.toContain('Draft, edit and mark up documents');
      expect(html).not.toContain('See you on');
      expect(html).not.toContain('NOT EXPECTING THIS?');
      expect(html).not.toContain('If you were not expecting this');
      expect(html).not.toContain('FOR QUERIES');
      expect(html).not.toContain('info@bdren.ai');
      expect(html).not.toContain('SENT TO');
      expect(html).not.toContain('Set a password and the account below');
      expect(html).not.toContain('nothing to pay for');
      expect(html).not.toContain('Takes under a minute');
      expect(html).not.toContain('The link works once');
      expect(html).not.toContain('is operated by');
    });
  });

  it('states the invitation in plain text, not as a heading', () => {
    const html = render(fullPayload);

    expect(html).not.toMatch(/<h1/i);
    expect(text(fullPayload)).toMatch(/<p [^>]*>You are invited to join Synapse\.<\/p>/);
  });

  it('shows the fallback link bold and unboxed', () => {
    const html = text(fullPayload);

    expect(html).toMatch(
      /Button not working\? Use the following link[\s\S]{0,200}?<a [^>]*font-weight: bold[^>]*>https:\/\/synapse\.example\.net\/register\?token=abc123<\/a>/,
    );
    expect(html).not.toContain('callout');
    expect(html).not.toContain('border: 2px');
  });

  it('asks the reader to accept the invitation', () => {
    const html = text(fullPayload);

    expect(html).toContain('>Accept invitation</a>');
    expect(html).not.toContain('>Set your password</a>');
  });

  it('centres the accept button and the copyright line', () => {
    const html = text(fullPayload);

    expect(html).toMatch(/<table [^>]*class="btn-table" align="center"/);
    expect(html).toMatch(/text-align: center;">Copyright/);
  });

  it('closes with the copyright line for the year it is sent in', () => {
    expect(text(fullPayload)).toContain('Copyright © 2026 BdREN. All rights reserved.');
    expect(text({ ...fullPayload, year: 2031 })).toContain('Copyright © 2031 BdREN.');
  });

  it('keeps the developer credit out of the header', () => {
    const html = text(fullPayload);

    expect(html).not.toContain('DEVELOPED BY THE');
    expect(html).not.toContain('Developed by the');
    expect(html).not.toContain('BDREN');
  });

  it('keeps dashes out of the copy', () => {
    const visible = (payload) =>
      text(payload)
        .replace(/<style[\s\S]*?<\/style>|<!--[\s\S]*?-->|<[^>]*>/g, ' ')
        .replace(/https?:\/\/\S+|mailto:\S+/g, '');

    expect(visible(fullPayload)).not.toMatch(/[–—]|\s-\s/);
    expect(visible(basePayload)).not.toMatch(/[–—]|\s-\s/);
  });

  it('declares and styles a dark scheme', () => {
    const html = render(fullPayload);

    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toContain('@media (prefers-color-scheme: dark)');
  });

  it('calls the product Synapse and credits BdREN as its developer, whatever the app title says', () => {
    const html = text({ ...fullPayload, appName: 'BdREN Synapse' });

    expect(html).toContain('Synapse is an AI workspace built by the');
    expect(html).not.toContain('BdREN Synapse');
  });

  it('links the team name to the organisation website', () => {
    const html = text(fullPayload);

    expect(html).toContain('BdREN Innovation Team</a>');
    expect(html).toContain('href="https://bdren.net.bd"');
  });

  it('still reads as a sentence when no organisation website is configured', () => {
    const html = text({ ...fullPayload, orgUrl: '', orgLabel: '' });

    expect(html).toContain('built by the BdREN Innovation Team for universities');
    expect(html).not.toContain('bdren.net.bd');
    expect(html).not.toMatch(/href="\s*"/);
  });

  it('drops the optional rows for a standalone invitation', () => {
    const html = text(basePayload);

    expect(html).toContain('You are invited to join Synapse.');
    expect(html).not.toContain('Invitation expires');
    expect(html).not.toContain('undefined');
  });

  it('never leaves an unresolved handlebars expression', () => {
    expect(render(fullPayload)).not.toMatch(/\{\{|\}\}/);
    expect(render(basePayload)).not.toMatch(/\{\{|\}\}/);
  });

  /** A flattened or renamed asset silently breaks the mail for every recipient,
   *  so the files the template points at are checked, not assumed. */
  it('points only at assets that exist', () => {
    const html = render(fullPayload);
    const referenced = [
      ...new Set([...html.matchAll(/\/assets\/([\w.-]+\.png)/g)].map((match) => match[1])),
    ];

    expect(referenced.length).toBeGreaterThan(0);
    for (const asset of referenced) {
      expect(fs.existsSync(path.join(ASSETS_DIR, asset))).toBe(true);
    }
  });

  it('ships transparent logos, so no white box shows on the cream or the dark paper', () => {
    ['synapse-email-logo-v3.png', 'synapse-email-logo-v3-dark.png'].forEach((name) => {
      const png = fs.readFileSync(path.join(ASSETS_DIR, name));
      /** IHDR colour-type byte: 6 is RGBA, 4 is grey+alpha, 3 is palette (may carry tRNS). */
      const colourType = png[25];

      expect([4, 6]).toContain(colourType);
    });
  });

  it('puts the Synapse lockup logo in the header, with a light wordmark for dark mode', () => {
    const html = render(fullPayload);

    expect(html).toContain('/assets/synapse-email-logo-v3.png');
    expect(html).toContain('/assets/synapse-email-logo-v3-dark.png');
    expect(html).not.toContain('synapse-email-icon');
    expect(html).toContain('.logo-light { display: none !important; }');
  });
});
