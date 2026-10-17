import { isValidElementType } from 'react-is';
import { SettingsTabValues } from 'librechat-data-provider';
import type { SettingsContextValue } from '../types';
import en from '~/locales/en/translation.json';
import { registry } from '../registry';
import { TABS } from '../types';

const validTabSections = new Map(TABS.map((t) => [t.id, new Set(t.sections.map((s) => s.id))]));

const settingsContext: SettingsContextValue = {
  balanceEnabled: false,
  quotaEnabled: false,
  hasAnyPersonalizationFeature: false,
  hasMemoryOptOut: false,
  hasStatefulCodeSessions: false,
  hasRemoteAgents: false,
  hasUserProvidedEndpoints: false,
  hasMultiConvo: false,
  hasPrompts: false,
  isLocalProvider: true,
  twoFactorEnabled: false,
  allowAccountDeletion: true,
  aboutEnabled: false,
  engineTTS: 'browser',
  langfuseConnectionAccess: false,
  adminPanelURL: '',
};

describe('settings registry', () => {
  it('has unique ids', () => {
    const ids = registry.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('references a valid tab and section for every entry', () => {
    for (const entry of registry) {
      const sections = validTabSections.get(entry.tab);
      expect(sections).toBeDefined();
      expect(sections!.has(entry.section)).toBe(true);
    }
  });

  it('uses label keys that exist in the English locale', () => {
    for (const entry of registry) {
      expect(en).toHaveProperty(entry.labelKey);
    }
  });

  it('has a renderable Component for every entry', () => {
    for (const entry of registry) {
      expect(isValidElementType(entry.Component)).toBe(true);
    }
  });

  describe('Langfuse connection visibility', () => {
    const langfuseEntry = registry.find((entry) => entry.id === 'langfuseConnection');

    it('places the connection in the Langfuse tab', () => {
      expect(langfuseEntry).toMatchObject({
        tab: SettingsTabValues.LANGFUSE,
        section: 'langfuse',
      });
    });

    it('shows the connection when the user can manage it', () => {
      expect(
        langfuseEntry?.show?.({
          ...settingsContext,
          langfuseConnectionAccess: true,
        }),
      ).toBe(true);
    });

    it('hides the connection without Langfuse config access', () => {
      expect(
        langfuseEntry?.show?.({
          ...settingsContext,
          langfuseConnectionAccess: false,
        }),
      ).toBe(false);
    });

    it('shows the connection in single-tenant mode without fanout', () => {
      expect(
        langfuseEntry?.show?.({
          ...settingsContext,
          langfuseConnectionAccess: true,
        }),
      ).toBe(true);
    });
  });

  describe('stateful workspace default visibility', () => {
    const entry = registry.find((setting) => setting.id === 'defaultStatefulWorkspace');

    it('shows the setting when stateful code sessions are available', () => {
      expect(entry?.show?.({ ...settingsContext, hasStatefulCodeSessions: true })).toBe(true);
    });

    it('hides the setting when stateful code sessions are unavailable', () => {
      expect(entry?.show?.({ ...settingsContext, hasStatefulCodeSessions: false })).toBe(false);
    });
  });
});

describe('billing rows', () => {
  const shown = (ctx: Partial<SettingsContextValue>) =>
    registry
      .filter((entry) => entry.show?.({ ...settingsContext, ...ctx }) !== false)
      .map((entry) => entry.id);

  /** Quota and the credit ledger are different units — weighted billing tokens
   *  vs. real provider cost — so showing both would present two numbers that
   *  disagree with no way to tell which one blocks a request. */
  it('never shows the quota row and the credit row together', () => {
    const ids = shown({ balanceEnabled: true, quotaEnabled: true });
    expect(ids).toContain('usageQuota');
    expect(ids).not.toContain('tokenCredits');
  });

  /** The regression this guards: the quota panel was invisible because the only
   *  billing row was gated on `balanceEnabled`, which is false on a usage plan. */
  it('shows the quota row when a usage policy applies but balance is off', () => {
    const ids = shown({ balanceEnabled: false, quotaEnabled: true });
    expect(ids).toContain('usageQuota');
    expect(ids).not.toContain('tokenCredits');
  });

  it('falls back to the credit row when no usage policy applies', () => {
    const ids = shown({ balanceEnabled: true, quotaEnabled: false });
    expect(ids).toContain('tokenCredits');
    expect(ids).not.toContain('usageQuota');
  });

  it('shows neither when both are off', () => {
    const ids = shown({ balanceEnabled: false, quotaEnabled: false });
    expect(ids).not.toContain('tokenCredits');
    expect(ids).not.toContain('usageQuota');
  });
});
