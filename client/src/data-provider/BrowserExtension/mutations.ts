import { useMutation } from '@tanstack/react-query';
import { MutationKeys, dataService } from 'librechat-data-provider';
import type { TBrowserExtensionCode, TBrowserExtensionSignOut } from 'librechat-data-provider';

/** A fresh one-time code for the browser extension. Nothing is cached: every code is new. */
export const useBrowserExtensionCode = () =>
  useMutation<TBrowserExtensionCode, Error>([MutationKeys.browserExtensionCode], () =>
    dataService.createBrowserExtensionCode(),
  );

/** Signs the user out of every browser extension they connected. */
export const useSignOutBrowserExtensions = () =>
  useMutation<TBrowserExtensionSignOut, Error>([MutationKeys.browserExtensionSignOut], () =>
    dataService.signOutBrowserExtensions(),
  );
