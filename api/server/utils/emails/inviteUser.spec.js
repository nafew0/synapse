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
    .replace(/&rarr;/g, '\u2192')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

describe('inviteUser email template', () => {
  it('renders every invitation detail it was given', () => {
    const html = text(fullPayload);

    expect(html).toContain('University of Dhaka has invited you to Synapse.');
    expect(html).toContain('nafisa.rahman@du.ac.bd');
    expect(html).toContain('25 September 2026');
    expect(html).toContain('info@bdren.ai');
    expect(html).toContain(fullPayload.inviteLink);
  });

  it('drops the optional rows for a standalone invitation', () => {
    const html = text(basePayload);

    expect(html).toContain('You have been invited to Synapse.');
    expect(html).not.toContain('Institution');
    expect(html).not.toContain('Open before');
    expect(html).not.toContain('Account');
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

  it('ships a transparent logo, so no white box shows on a tinted header', () => {
    const png = fs.readFileSync(path.join(ASSETS_DIR, 'synapse-email-icon.png'));
    /** IHDR colour-type byte: 6 is RGBA, 4 is grey+alpha, 3 is palette (may carry tRNS). */
    const colourType = png[25];

    expect([4, 6]).toContain(colourType);
  });
});
