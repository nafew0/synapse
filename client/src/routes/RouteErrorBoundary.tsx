import { useEffect } from 'react';
import { Button } from '@librechat/client';
import { PublicErrorCodes } from 'librechat-data-provider';
import { useNavigate, useRouteError } from 'react-router-dom';
import { ReportButton } from '~/components/Report';
import { recordError } from '~/utils/errors';
import { useLocalize } from '~/hooks';
import logger from '~/utils/logger';

interface UserAgentData {
  getHighEntropyValues(hints: string[]): Promise<{ platform: string; platformVersion: string }>;
}

type PlatformInfo = {
  os: string;
  version?: string;
};

const formatStackTrace = (stack: string) => {
  return stack
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, i) => ({
      number: i + 1,
      content: line,
    }));
};

const getPlatformInfo = async (): Promise<PlatformInfo> => {
  if ('userAgentData' in navigator) {
    try {
      const ua = navigator.userAgentData as UserAgentData;
      const highEntropyValues = await ua.getHighEntropyValues(['platform', 'platformVersion']);
      return {
        os: highEntropyValues.platform,
        version: highEntropyValues.platformVersion,
      };
    } catch (e) {
      logger.warn('Failed to get high entropy values');
      logger.error(e);
    }
  }

  const userAgent = navigator.userAgent.toLowerCase();

  if (userAgent.includes('mac')) {
    return { os: 'macOS' };
  }
  if (userAgent.includes('win')) {
    return { os: 'Windows' };
  }
  if (userAgent.includes('linux')) {
    return { os: 'Linux' };
  }
  if (userAgent.includes('android')) {
    return { os: 'Android' };
  }
  if (userAgent.includes('ios') || userAgent.includes('iphone') || userAgent.includes('ipad')) {
    return { os: 'iOS' };
  }

  return { os: 'Unknown' };
};

const getBrowserInfo = async () => {
  const platformInfo = await getPlatformInfo();
  return {
    userAgent: navigator.userAgent,
    platform: platformInfo.os,
    platformVersion: platformInfo.version,
    language: navigator.language,
    windowSize: `${window.innerWidth}x${window.innerHeight}`,
  };
};

type TRouteError = {
  message?: string;
  stack?: string;
  status?: number;
  statusText?: string;
  data?: unknown;
};

/** Raw error data, stack trace and log download; only rendered in development builds. */
function DevDetails({ error }: { error: TRouteError }) {
  const localize = useLocalize();
  const errorDetails = {
    message: error.message ?? '',
    stack: error.stack,
    status: error.status,
    statusText: error.statusText,
    data: error.data,
  };

  const handleDownloadLogs = async () => {
    try {
      const browser = await getBrowserInfo();
      const errorLog = {
        timestamp: new Date().toISOString(),
        browser,
        error: {
          ...errorDetails,
          stack:
            errorDetails.stack != null && errorDetails.stack.trim() !== ''
              ? formatStackTrace(errorDetails.stack)
              : undefined,
        },
      };

      const blob = new Blob([JSON.stringify(errorLog, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `error-log-${new Date().toISOString()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      logger.warn('Failed to download error logs:');
      logger.error(e);
    }
  };

  const handleCopyStack = async () => {
    if (errorDetails.stack != null && errorDetails.stack !== '') {
      await navigator.clipboard.writeText(errorDetails.stack);
    }
  };

  return (
    <div className="mt-6 text-left">
      {/* Error Message */}
      <div className="mb-4 rounded-xl border border-status-error-border bg-status-error-subtle p-4 text-sm text-text-secondary">
        <h3 className="mb-2 font-medium">{localize('com_ui_error_message_prefix')}</h3>
        <pre className="whitespace-pre-wrap text-sm font-light leading-relaxed text-text-primary">
          {errorDetails.message}
        </pre>
      </div>

      {/* Status Information */}
      {(typeof errorDetails.status === 'number' || typeof errorDetails.statusText === 'string') && (
        <div className="mb-4 rounded-xl border border-status-warning-border bg-status-warning-subtle p-4 text-sm text-text-primary">
          <h3 className="mb-2 font-medium">{localize('com_ui_status_prefix')}:</h3>
          <p className="text-text-primary">
            {typeof errorDetails.status === 'number' && `${errorDetails.status} `}
            {typeof errorDetails.statusText === 'string' && errorDetails.statusText}
          </p>
        </div>
      )}

      {/* Stack Trace - Collapsible */}
      {errorDetails.stack != null && errorDetails.stack.trim() !== '' && (
        <details className="group mb-4 rounded-xl border border-border-light p-4">
          <summary className="mb-2 flex cursor-pointer items-center justify-between text-sm font-medium text-text-primary">
            <span>{localize('com_ui_stack_trace')}</span>
            <div className="flex items-center">
              <Button
                variant="outline"
                size="sm"
                onClick={handleCopyStack}
                className="ml-2 px-2 py-1 text-xs"
                aria-label={localize('com_ui_copy_stack_trace')}
              >
                {localize('com_ui_copy')}
              </Button>
            </div>
          </summary>
          <div className="overflow-x-auto rounded-lg bg-surface-tertiary p-4">
            {formatStackTrace(errorDetails.stack).map(({ number, content }) => (
              <div key={number} className="flex">
                <span className="select-none pr-4 font-mono text-xs text-text-secondary">
                  {String(number).padStart(3, '0')}
                </span>
                <pre className="flex-1 font-mono text-xs leading-relaxed text-text-primary">
                  {content}
                </pre>
              </div>
            ))}
          </div>
        </details>
      )}

      {/* Additional Error Data */}
      {errorDetails.data != null && (
        <details className="group mb-4 rounded-xl border border-border-light p-4">
          <summary className="mb-2 flex cursor-pointer items-center justify-between text-sm font-medium text-text-primary">
            <span>{localize('com_ui_additional_details')}</span>
            <span className="transition-transform group-open:rotate-90">{'>'}</span>
          </summary>
          <pre className="whitespace-pre-wrap text-xs font-light leading-relaxed text-text-primary">
            {JSON.stringify(errorDetails.data, null, 2)}
          </pre>
        </details>
      )}

      <Button
        variant="outline"
        onClick={handleDownloadLogs}
        className="w-full sm:w-auto"
        aria-label={localize('com_ui_download_error_logs')}
      >
        {localize('com_ui_download_error_logs')}
      </Button>
    </div>
  );
}

export default function RouteErrorBoundary() {
  const localize = useLocalize();
  const navigate = useNavigate();
  const error = useRouteError() as TRouteError;
  const isDev = import.meta.env.DEV === true;

  useEffect(() => {
    recordError({ code: PublicErrorCodes.UNKNOWN });
  }, []);

  return (
    <div
      role="alert"
      className="flex min-h-screen flex-col items-center justify-center bg-surface-primary"
    >
      <div className="mx-4 w-11/12 max-w-xl rounded-2xl border border-border-light bg-surface-primary p-8 text-center shadow-lg">
        <h2 className="mb-3 text-2xl font-medium tracking-tight text-text-primary">
          {localize('com_error_page_title')}
        </h2>
        <p className="text-sm text-text-secondary">{localize('com_error_page_body')}</p>
        <div className="mt-6 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
          <Button
            variant="submit"
            onClick={() => window.location.reload()}
            className="w-full sm:w-auto"
          >
            {localize('com_ui_reload')}
          </Button>
          <Button variant="outline" onClick={() => navigate('/')} className="w-full sm:w-auto">
            {localize('com_ui_go_home')}
          </Button>
          <ReportButton code={PublicErrorCodes.UNKNOWN} />
        </div>
        {isDev && <DevDetails error={error} />}
      </div>
    </div>
  );
}
