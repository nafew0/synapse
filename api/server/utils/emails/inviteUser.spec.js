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
    .replace(/&rarr;/g, '\u2192')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

describe('inviteUser email template', () => {
  it('renders every invitation detail it was given', () => {
    const html = text(fullPayload);

    expect(html).not.toContain('Invitation \u00b7');
    expect(html).toContain('ACCOUNT');
    expect(html).toContain('ORGANIZATION');
    expect(html).toContain('OPEN BEFORE');
    expect(html).not.toContain('SENT TO');
    expect(html).toMatch(/FOR QUERIES<\/span><a [^>]*>info@bdren\.ai<\/a>/);
    expect(html).toContain('You are invited to join Synapse.');
    expect(html).toContain('University of Dhaka');
    expect(html).toContain('nafisa.rahman@du.ac.bd');
    expect(html).toContain('25 September 2026');
    expect(html).toContain('info@bdren.ai');
    expect(html).toContain(fullPayload.inviteLink);
  });

  it('keeps the headline generic and names the organization in the details', () => {
    const html = text(fullPayload);

    expect(html).not.toContain('University of Dhaka has invited you');
    expect(html).toContain('ORGANIZATION</div> <div');
    expect(html).toContain('>University of Dhaka</div>');
  });

  it('shows only the detail cells it has a value for', () => {
    const emailOnly = text({ ...basePayload, email: fullPayload.email });
    const orgOnly = text({ ...basePayload, institutionName: fullPayload.institutionName });
    const expiryOnly = text({ ...basePayload, expiresOn: fullPayload.expiresOn });

    expect(emailOnly).toContain('ACCOUNT');
    expect(emailOnly).not.toContain('OPEN BEFORE');
    expect(emailOnly).not.toContain('ORGANIZATION');
    expect(orgOnly).toContain('ORGANIZATION');
    expect(orgOnly).not.toContain('ACCOUNT');
    expect(expiryOnly).toContain('OPEN BEFORE');
    expect(expiryOnly).not.toContain('ACCOUNT');
  });

  it('always tells a wrongly addressed reader what to do', () => {
    const note = 'If you were not expecting this, ignore it. No account exists until the link is opened.';

    [fullPayload, basePayload].forEach((payload) => {
      expect(text(payload)).toContain('NOT EXPECTING THIS?');
      expect(text(payload)).toContain(note);
    });
    expect(text(basePayload)).not.toContain('FOR QUERIES');
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

    expect(html).toContain('See you on Synapse,<br>BdREN Innovation Team');
    expect(html).toContain('Synapse is an AI workspace built by the');
    expect(html).not.toContain('BdREN Synapse');
  });

  it('links the team name and the footer to the organisation website', () => {
    const html = text(fullPayload);

    expect(html).toContain('BdREN Innovation Team</a>');
    expect(html).toContain('Synapse is operated by BdREN');
    expect(html).toContain('href="https://bdren.net.bd"');
    expect(html).toContain('>bdren.net.bd</a>');
  });

  it('still reads as a sentence when no organisation website is configured', () => {
    const html = text({ ...fullPayload, orgUrl: '', orgLabel: '' });

    expect(html).toContain('built by the BdREN Innovation Team for universities');
    expect(html).toContain('operated by BdREN, Bangladesh Research and Education Network');
    expect(html).not.toContain('bdren.net.bd');
    expect(html).not.toMatch(/href="\s*"/);
  });

  it('drops the optional rows for a standalone invitation', () => {
    const html = text(basePayload);

    expect(html).toContain('You are invited to join Synapse.');
    expect(html).not.toContain('ORGANIZATION');
    expect(html).not.toContain('OPEN BEFORE');
    expect(html).not.toContain('ACCOUNT');
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
