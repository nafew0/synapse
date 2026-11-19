import { Lock, Mail, ExternalLink } from 'lucide-react';
import type { TUserChatAccess } from 'librechat-data-provider';
import { useGetUserQuery } from '~/data-provider';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

const CONTACT_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A mailto link for an email address, the link itself for an http(s) URL, or `null`. */
export function contactHref(contact?: string): string | null {
  const value = contact?.trim();
  if (!value) {
    return null;
  }
  if (CONTACT_EMAIL.test(value)) {
    return `mailto:${value}`;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Takes the composer's place once the user's institution has ended chat access, so members learn
 * it before typing rather than from a refused message. Rechecks on window focus, so restoring
 * access brings the composer back without a reload.
 */
export default function AccessEnded({
  access,
  className,
}: {
  access: TUserChatAccess;
  className?: string;
}) {
  const localize = useLocalize();
  useGetUserQuery({ refetchOnWindowFocus: true });
  const href = contactHref(access.contact);
  const isEmail = href?.startsWith('mailto:') === true;
  const ContactIcon = isEmail ? Mail : ExternalLink;

  return (
    <section
      role="status"
      aria-labelledby="access-ended-title"
      className={cn('mx-auto w-full sm:px-2 md:max-w-3xl xl:max-w-4xl', className)}
    >
      <div className="flex gap-3.5 rounded-t-3xl border border-status-warning-border bg-surface-chat px-5 py-4 shadow-md sm:gap-4 sm:rounded-3xl">
        <div className="flex size-9 flex-none items-center justify-center rounded-xl bg-status-warning-subtle sm:size-10">
          <Lock className="size-[18px] text-status-warning sm:size-5" aria-hidden={true} />
        </div>
        <div className="min-w-0 flex-1">
          <h2
            id="access-ended-title"
            className="mb-1 text-[15px] font-semibold text-text-primary sm:text-base"
          >
            {localize('com_error_access_ended_title')}
          </h2>
          <p className="whitespace-pre-line text-sm leading-relaxed text-text-secondary sm:text-[15px]">
            {access.message ?? localize('com_error_access_ended')}
          </p>
          <p className="mt-1 text-sm text-text-secondary">
            {localize('com_ui_access_ended_history')}
          </p>
          {href != null && (
            <a
              href={href}
              target={isEmail ? undefined : '_blank'}
              rel={isEmail ? undefined : 'noopener noreferrer'}
              className="mt-3 inline-flex items-center gap-2 rounded-lg border border-border-medium px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-ring-primary"
            >
              <ContactIcon className="size-4" aria-hidden={true} />
              {localize('com_ui_access_ended_contact')}
            </a>
          )}
        </div>
      </div>
    </section>
  );
}
