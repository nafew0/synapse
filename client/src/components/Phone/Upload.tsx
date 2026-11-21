import { useRef, useState, useCallback } from 'react';
import { v4 } from 'uuid';
import { useParams } from 'react-router-dom';
import { dataService } from 'librechat-data-provider';
import { Button, Spinner } from '@librechat/client';
import { CheckCircle2, AlertCircle, Smartphone } from 'lucide-react';
import { usePhoneUploadStatus } from '~/data-provider';
import { useLocalize, useDocumentTitle } from '~/hooks';

type SendState = 'sending' | 'sent' | 'failed';

interface SendItem {
  id: string;
  name: string;
  state: SendState;
  progress: number;
  error?: string;
}

const errorText = (error: unknown): string | undefined => {
  const data = (error as { response?: { data?: { error?: string; message?: string } } } | null)
    ?.response?.data;
  return data?.error ?? data?.message;
};

/** The one-button screen a phone opens from the QR code: picks files and sends them to the desktop chat. */
export default function PhoneUpload() {
  const localize = useLocalize();
  const { token } = useParams<{ token: string }>();
  const inputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<SendItem[]>([]);
  const [limitedTo, setLimitedTo] = useState<number | null>(null);
  const [linkGone, setLinkGone] = useState(false);
  const status = usePhoneUploadStatus(token);
  const { refetch } = status;
  useDocumentTitle(localize('com_ui_phone_page_title'));

  const pending = items.reduce((count, item) => count + (item.state === 'sending' ? 1 : 0), 0);
  /** The server counts every file this code has taken, so other phones and reloads stay in step. */
  const room = status.data ? Math.max(status.data.maxFiles - status.data.received - pending, 0) : 0;
  const isSending = pending > 0;
  const isGone = linkGone || status.isError;

  const update = useCallback((id: string, patch: Partial<SendItem>) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  const send = useCallback(
    async (files: File[]) => {
      if (!token) {
        return;
      }
      const queued = files.map((file) => ({ file, id: v4() }));
      setItems((prev) => [
        ...prev,
        ...queued.map(({ file, id }) => ({
          id,
          name: file.name,
          state: 'sending' as const,
          progress: 0,
        })),
      ]);
      for (const { file, id } of queued) {
        const form = new FormData();
        form.append('file_id', id);
        form.append('file', file, encodeURIComponent(file.name));
        try {
          await dataService.sendPhoneUploadFile(token, form, (_fileId, fraction) =>
            update(id, { progress: fraction }),
          );
          await refetch();
          update(id, { state: 'sent', progress: 1 });
        } catch (error) {
          const code = (error as { response?: { status?: number } } | null)?.response?.status;
          if (code === 404) {
            setLinkGone(true);
          }
          update(id, { state: 'failed', error: errorText(error) });
        }
      }
    },
    [token, update, refetch],
  );

  const onPick = (event: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (picked.length === 0) {
      return;
    }
    setLimitedTo(picked.length > room ? room : null);
    send(picked.slice(0, room));
  };

  if (status.isLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-surface-primary">
        <Spinner className="text-text-secondary" />
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col items-center bg-surface-primary px-4 py-10 text-text-primary">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-surface-secondary">
            <Smartphone className="size-6 text-text-secondary" aria-hidden="true" />
          </span>
          <h1 className="text-xl font-semibold">
            {localize(isGone ? 'com_ui_phone_page_expired_title' : 'com_ui_phone_page_title')}
          </h1>
          <p className="text-sm text-text-secondary">
            {localize(isGone ? 'com_ui_phone_page_expired' : 'com_ui_phone_page_description')}
          </p>
        </div>

        {!isGone && (
          <div className="flex flex-col items-center gap-2">
            <input
              ref={inputRef}
              type="file"
              multiple
              className="hidden"
              onChange={onPick}
              data-testid="phone-upload-input"
            />
            <Button
              size="lg"
              className="w-full"
              disabled={room === 0 || isSending}
              onClick={() => inputRef.current?.click()}
            >
              {localize('com_ui_phone_page_choose')}
            </Button>
            <span className="text-xs text-text-secondary">
              {room === 0
                ? localize('com_ui_phone_page_full')
                : localize('com_ui_phone_page_room', { 0: room })}
            </span>
            {limitedTo != null && (
              <span className="text-xs text-text-secondary" role="status">
                {localize('com_ui_phone_page_too_many', { 0: limitedTo })}
              </span>
            )}
          </div>
        )}

        {items.length > 0 && (
          <ul className="flex flex-col gap-2" aria-live="polite">
            {items.map((item) => (
              <li
                key={item.id}
                className="flex flex-col gap-1 rounded-xl border border-border-light bg-surface-secondary px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  {item.state === 'sending' && <Spinner className="size-4 text-text-secondary" />}
                  {item.state === 'sent' && (
                    <CheckCircle2 className="size-4 text-text-secondary" aria-hidden="true" />
                  )}
                  {item.state === 'failed' && (
                    <AlertCircle className="size-4 text-text-secondary" aria-hidden="true" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm">{item.name}</span>
                  <span className="text-xs text-text-secondary">
                    {item.state === 'sending'
                      ? `${localize('com_ui_phone_page_sending')} ${Math.round(item.progress * 100)}%`
                      : localize(
                          item.state === 'sent'
                            ? 'com_ui_phone_page_sent'
                            : 'com_ui_phone_page_failed',
                        )}
                  </span>
                </div>
                {item.error != null && (
                  <span className="text-xs text-text-secondary">{item.error}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
