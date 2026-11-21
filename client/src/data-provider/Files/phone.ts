import { useMutation, useQuery } from '@tanstack/react-query';
import { QueryKeys, dataService } from 'librechat-data-provider';
import type { UseMutationResult, QueryObserverResult } from '@tanstack/react-query';
import type t from 'librechat-data-provider';

/** How often the desktop checks for files sent from the phone. */
export const PHONE_UPLOAD_POLL_MS = 2000;
/** How often the open phone page checks in, so the desktop can show it as connected. */
export const PHONE_UPLOAD_HEARTBEAT_MS = 5000;

export const useCreatePhoneUploadSession = (): UseMutationResult<
  t.PhoneUploadSessionCreated,
  unknown,
  t.PhoneUploadSessionBody
> => useMutation((body: t.PhoneUploadSessionBody) => dataService.createPhoneUploadSession(body));

/** Polls an open session while the QR dialog is showing; stops once the session has ended. */
export const usePhoneUploadSession = (
  sessionId: string | undefined,
  enabled: boolean,
): QueryObserverResult<t.PhoneUploadSession, unknown> =>
  useQuery<t.PhoneUploadSession, unknown>(
    [QueryKeys.phoneUploadSession, sessionId],
    () => dataService.getPhoneUploadSession(sessionId ?? ''),
    {
      enabled: enabled && !!sessionId,
      refetchInterval: (data, query) =>
        query.state.status === 'error' ? false : PHONE_UPLOAD_POLL_MS,
      refetchIntervalInBackground: true,
      refetchOnWindowFocus: false,
      retry: false,
      cacheTime: 0,
    },
  );

/** What the phone needs to know about the link it opened; polling it is the phone's heartbeat. */
export const usePhoneUploadStatus = (
  token: string | undefined,
): QueryObserverResult<t.PhoneUploadStatus, unknown> =>
  useQuery<t.PhoneUploadStatus, unknown>(
    [QueryKeys.phoneUploadStatus, token],
    () => dataService.getPhoneUploadStatus(token ?? ''),
    {
      enabled: !!token,
      retry: false,
      refetchOnWindowFocus: true,
      refetchInterval: (data, query) =>
        query.state.status === 'error' ? false : PHONE_UPLOAD_HEARTBEAT_MS,
      refetchIntervalInBackground: false,
    },
  );
