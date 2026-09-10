import { useRecoilValue } from 'recoil';
import { QueryKeys, MutationKeys, dataService } from 'librechat-data-provider';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  UseMutationResult,
  QueryObserverResult,
  UseQueryOptions,
} from '@tanstack/react-query';
import type t from 'librechat-data-provider';
import store from '~/store';

/** Keyed by user so a banner fetched on the login page is not reused after sign-in. */
const bannerQueryKey = (userId?: string) => [QueryKeys.banner, userId ?? 'anonymous'];

export const useGetBannerQuery = (
  userId?: string,
  config?: UseQueryOptions<t.TBannerResponse>,
): QueryObserverResult<t.TBannerResponse> => {
  const queriesEnabled = useRecoilValue<boolean>(store.queriesEnabled);
  return useQuery<t.TBannerResponse>(bannerQueryKey(userId), () => dataService.getBanner(), {
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    ...config,
    enabled: (config?.enabled ?? true) === true && queriesEnabled,
  });
};

export const useMarkBannerSeenMutation = (): UseMutationResult<void, unknown, string> =>
  useMutation([MutationKeys.markBannerSeen], (bannerId: string) =>
    dataService.markBannerSeen(bannerId),
  );

export const useDismissBannerMutation = (
  userId?: string,
): UseMutationResult<void, unknown, string> => {
  const queryClient = useQueryClient();
  return useMutation(
    [MutationKeys.dismissBanner],
    (bannerId: string) => dataService.dismissBanner(bannerId),
    {
      onMutate: () => queryClient.setQueryData<t.TBannerResponse>(bannerQueryKey(userId), null),
    },
  );
};

export const useGetUserBalance = (
  config?: UseQueryOptions<t.TBalanceResponse>,
): QueryObserverResult<t.TBalanceResponse> => {
  const queriesEnabled = useRecoilValue<boolean>(store.queriesEnabled);
  return useQuery<t.TBalanceResponse>([QueryKeys.balance], () => dataService.getUserBalance(), {
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchOnMount: true,
    ...config,
    enabled: (config?.enabled ?? true) === true && queriesEnabled,
  });
};

export const useGetSearchEnabledQuery = (
  config?: UseQueryOptions<boolean>,
): QueryObserverResult<boolean> => {
  const queriesEnabled = useRecoilValue<boolean>(store.queriesEnabled);
  return useQuery<boolean>([QueryKeys.searchEnabled], () => dataService.getSearchEnabled(), {
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    ...config,
    enabled: (config?.enabled ?? true) === true && queriesEnabled,
  });
};
