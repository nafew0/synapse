import { QRCodeSVG } from 'qrcode.react';
import { CheckCircle2, RefreshCw } from 'lucide-react';
import {
  Button,
  OGDialog,
  Spinner,
  OGDialogTitle,
  OGDialogContent,
  OGDialogDescription,
} from '@librechat/client';
import type { PhoneUploadView } from '~/hooks/Files/usePhoneUpload';
import { useLocalize } from '~/hooks';

interface PhoneUploadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  view: PhoneUploadView;
}

const formatTime = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Shows the QR code a phone scans to send files into this chat, and what has arrived so far. */
export default function PhoneUploadDialog({ open, onOpenChange, view }: PhoneUploadDialogProps) {
  const localize = useLocalize();
  const { state, link, expiresAt, received, phoneConnected, restart } = view;
  const isEnded = state === 'expired' || state === 'error';

  return (
    <OGDialog open={open} onOpenChange={onOpenChange}>
      <OGDialogContent className="w-11/12 max-w-sm overflow-hidden rounded-2xl [&>*]:min-w-0">
        <OGDialogTitle className="text-base font-semibold leading-6 text-text-primary">
          {localize('com_ui_upload_from_phone')}
        </OGDialogTitle>
        <OGDialogDescription className="text-sm text-text-secondary">
          {localize('com_ui_phone_upload_description')}
        </OGDialogDescription>

        <div className="flex flex-col items-center gap-3 py-2" aria-live="polite">
          <div className="flex size-[212px] items-center justify-center rounded-2xl bg-white p-4 shadow-lg">
            {state === 'ready' && link != null ? (
              <QRCodeSVG
                value={link}
                size={180}
                marginSize={0}
                title={localize('com_ui_phone_upload_qr')}
                data-testid="phone-upload-qr"
              />
            ) : (
              !isEnded && <Spinner className="text-text-secondary" />
            )}
            {isEnded && (
              <span className="px-2 text-center text-sm text-text-secondary">
                {localize(
                  state === 'expired' ? 'com_ui_phone_upload_expired' : 'com_ui_phone_upload_error',
                )}
              </span>
            )}
          </div>

          {phoneConnected && (
            <span
              className="flex items-center gap-2 text-sm font-medium text-text-primary"
              role="status"
              data-testid="phone-upload-connected"
            >
              <span className="relative flex size-2.5" aria-hidden="true">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-status-success opacity-75 motion-reduce:animate-none" />
                <span className="relative inline-flex size-2.5 rounded-full bg-status-success" />
              </span>
              {localize('com_ui_phone_upload_connected')}
            </span>
          )}

          {state === 'ready' && expiresAt != null && (
            <span className="text-xs text-text-secondary">
              {localize('com_ui_phone_upload_expires', { 0: formatTime(expiresAt) })}
            </span>
          )}

          {isEnded && (
            <Button variant="outline" onClick={restart} className="gap-2">
              <RefreshCw className="size-4" aria-hidden="true" />
              {localize('com_ui_phone_upload_new_code')}
            </Button>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-1.5 border-t border-border-light pt-3">
          {received.length === 0 ? (
            state === 'ready' && (
              <span className="text-sm text-text-secondary">
                {localize('com_ui_phone_upload_waiting')}
              </span>
            )
          ) : (
            <>
              <span className="text-xs font-medium text-text-secondary">
                {localize('com_ui_phone_upload_received')}
              </span>
              <ul className="flex max-h-32 min-w-0 flex-col gap-1 overflow-y-auto">
                {received.map((file) => (
                  <li
                    key={file.fileId}
                    className="flex min-w-0 items-center gap-2 text-sm text-text-primary"
                  >
                    <CheckCircle2
                      className="size-4 shrink-0 text-text-secondary"
                      aria-hidden="true"
                    />
                    <span className="min-w-0 truncate">{file.filename}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </OGDialogContent>
    </OGDialog>
  );
}
